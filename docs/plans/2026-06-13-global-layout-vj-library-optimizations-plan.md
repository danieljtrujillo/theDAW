# Global Edit Layout, VJ Video Library, and Optimization Plan

**Date:** 2026-06-13
**Scope:** ControlSurface conversion of MAKE/EDIT/LEARN, library video/image media kinds with VJ persistence + overlays, VJ production-build sidecar, targeted performance fixes.
**Branch state when written:** `feat/slide-controller-and-midi-engine` pushed as PR #19 (controller fit/zoom/pan, SLIDE sticky page dock, piano-transcription-inference). PRs #14-#16 merged earlier.

---

## 0. Source feature requests (user, verbatim)

> I would like the Edit Layout feature to be global, and all of the rules about filling gaps and all that to apply. I need to be able to edit every tab.
>
> I would like the VJ page to save whatever videos are loaded into it's library, in the cue unless removed. They should be stored efficiently in the library with their own video tab, still images should be importable, transparent png, webp, webm, mp4 etc can act as overlays.
>
> Try to find ways we can optimize the VJ tab/sidecar so it runs more efficiently/smoothly. If there are efficiency gains to be had elsewhere (like optimizing everything in our library) I am all ears.

Added later (user, verbatim):

> finish integrating the live stems in DJ, have the sampler and stem activation super simple, but versatile. Fill some of those gaps.

Added later (user, verbatim, 2026-06-13):

> Make a plan for making essentially the whole app right clickable, so I can send any track anywhere to the library,(adding to library isnt working right now) it should have multiselect, send all to _____, stem, delete, compress/archive, add to init, send here send there send everywhere.
>
> You should always always make sure that you break these tasks (even the planning) down into small manageable tasks so you can keep track, and dont overload your context. Add these requests to the most recent plan doc (i think like 2 days old)
>
> Cymatics visualizers should be mixable into the VJ feed.
>
> The EDIT tab, should by default have however many tracks/lanes as it needs to fill up the screen, so prob like 10
>
> VOICE/MIC INPUT Needs to be integrated into the footer (just a simple record icon for now) and be able to be plugged into anywhere to record. record into init, edit lanes, midi, I have a vocoder for us to integrate into this app D:\StableAudio\JoshOG\KhoomeiVocoder but not dependent on that external folder after integration.
>
> All tracks/lanes should have a mic input button, ability to add the effects/stacks that we have.
>
> I need to be able to use the videos that are imported into the library, currently there's no function whatsoever or exposed ability to do anything with em. Videos and images should be automatically highly optimized without losing noticable quality. Whatever codec is small and would run the best in this app to keep overhead low.
>
> managing adding, saving playlists in DJ tab should be much easier. The pause play skip on the footer should control the track playheads.
>
> More granularity on the SUGGEST options.

Already shipped from the same request batch (PR #19): SLIDE Row/Focus bottom-anchored lanes + sticky `.sl-pagedock`, controller view fit-on-open/wheel-zoom/drag-pan, piano-transcription-inference installed + declared. Visual sign-off on the SLIDE behaviors is still pending the user's eyes.

---

## 1. Verified architecture facts (from code exploration, 2026-06-13)

### Layout system
- Global prefs: `frontend/src/state/layoutPrefsStore.ts` (fillMode, gapPx, snapPx, showGuides, matchSizes, uiScale; localStorage `thedaw.layoutprefs.v1`). Consumed by `WidgetCell.tsx`, `FrGrid.tsx`, `dnd.ts`.
- Per-surface layouts: `frontend/src/state/surfaceLayoutStore.ts` — `createLayoutStore(surfaceId, defaultLayout)`, persisted to localStorage `thedaw.surface.{id}.v1`, saved default at `thedaw.surface.{id}.default.v{n}`. History/undo built in. Gap-filling = `fillAdjacent(nodeId)` (line ~739), exposed via panel right-click "Fill adjacent gap"; manual, not automatic.
- Renderer: `frontend/src/components/surface/ControlSurface.tsx` + `SurfaceToolbar.tsx` (the "Edit Layout" button), `FrGrid.tsx` (fr grid + splitters), `SurfacePanel.tsx`, `WidgetCell.tsx`. Design-mode hotkeys: Ctrl+Z/Y/S, Esc, M/U/L/F/X/Del on hover.
- **Already ControlSurface:** MIX (`MixView.tsx`, id `mix`), DJ (`DJView.tsx`, id `dj`), TRAIN (`TrainView.tsx`, id `train`).
- **Not yet:** MAKE (`views/AdvancedGenPanel.tsx` — bespoke flex, ~1500 lines), EDIT (`components/audio/WaveformEditor.tsx` — own resizable panels), LEARN (`LineageView.tsx`). VJ is an iframe (cannot join; its app has its own internals). LIBRARY is the right rail (fixed, out of scope).

### VJ subsystem
- Embed: `frontend/src/views/VJView.tsx` — iframe to port 5187, URL from `GET /api/vj/url` (lazy spawn). postMessage bridge: audio-levels at 30fps, MIDI, playback, visibility (`sa3-vj/visibility` parks the render loop), control sync, SET hand-off (`sa3-vj/load-set` → ACK `sa3-vj/set-loaded` via `vjSetBus.ts`).
- Sidecar: `backend/modules/vj/sidecar.py` spawns `npm run dev -- --port 5187` in `D:/StableAudio/GANTASMO-LIVE-VJ` (override `theDAW_VJ_PROJECT`). **Dev server, not a production build.** Export: browser webm → `POST /api/vj/export` → ffmpeg transcode (`export.py`).
- VJ app state: `GANTASMO-LIVE-VJ/src/App.tsx` persists `VJState` incl. `videoBucket: VideoClip[]` to localStorage `gantasmo_veejay_state_2`, **but drops every `blob:` URL on save AND load** (App.tsx ~lines 45-64, 281-294). Stable http URLs survive reload. `VideoClip = { id, name, url, size?, kind?: 'video'|'audio' }` (types.ts). File imports route through `fileRouter.ts` and become blob URLs today — that is exactly why the cue dies on reload.
- Render loop: `VideoOutput.tsx` — rAF loop with visibility early-return, perf tiers (1.0/0.75/0.5 backing scale), two-phase read/write fisheye, lazy depth proxy, separate locked-resolution record canvas, MediaRecorder VP9+Opus.

### Library
- DB: `backend/modules/library/db.py`, SCHEMA_VERSION 4. `entries.kind` column EXISTS (default 'audio'), only 'audio' written today. Tables: entries, analysis, stems, midis, relations, tag_index, prompt_corpus.
- Files: `data/generations/<entry_id>/` with `metadata.json` + media file. Audio streams via `/api/library/audio/<id>` with range support (pattern to copy for video).
- UI: `frontend/src/views/LibraryView.tsx` with subTab state: tracks | stems | midi.

### Performance facts
- Audit N2 (judge-validated): `GET /api/jobs` (`backend/server.py` ~1557) returns every job's full base64 audio + spectrograms; `trainingStore` polls it.
- `AdvancedGenPanel.tsx:249` subscribes to the WHOLE params store (`const p = useGenerateParamsStore()`) — full MAKE re-render per keystroke/fader tick.
- App-wide ~1.1x CSS transform scale on an ancestor (see memory `project_ui_css_transform_scale`): extra rasterization everywhere; any change must keep getBoundingClientRect-based canvas mapping working.

---

## 2. Execution order (agreed shape; user green-light pending per phase)

1. **Phase A — quick wins:** VJ production-build sidecar + `/api/jobs` payload strip.
2. **Phase B — VJ video library** (4 sub-phases below).
3. **Phase C — global Edit Layout**: MAKE → EDIT → LEARN, one PR each.
4. **Phase D — micro-perf**: rVFC in VJ loop, selector-izing big views, H264 recording option.
5. **Phase E — DJ live stems finish + simple sampler/stem activation** (section 6.5). Can be pulled ahead of C/D on green-light; it is independent of the layout and VJ work.
6. **Phase F — library Opus autoconvert** (section 6.6). Audit-first: a compatibility matrix of every consumer of library audio BEFORE any conversion code. User: library is getting big quickly; this is a real disk-pressure item.
7. **Phase H — active incident fix** (section 6.8): stems sidecar dependency/probe hardening + Windows MIDI charmap fix. This can be pulled to the very front because it is an active failure.
8. **Phase G — global right-click routing + mic/media/DJ/SUGGEST expansion** (section 6.7): execute only after add-to-library reliability is green, because every send-anywhere workflow depends on it.

---

## 3. Phase A — quick wins

### A1. VJ sidecar serves a production build
File: `backend/modules/vj/sidecar.py`.
- On spawn: if `dist/` missing or stale vs `src/` mtimes (cheap newest-file compare), run `npm run build` once (background, log progress), then serve `dist/` — either `npm run preview -- --port 5187` or (better, fewer moving parts) a tiny static mount on the FastAPI backend? NO — keep same-origin behavior identical: `vite preview` keeps the same port contract and SPA fallback. Use `vite preview --strictPort`.
- Env escape hatch `theDAW_VJ_DEV=1` to force the dev server (HMR while developing the VJ app itself).
- Gotcha: `npm run preview` needs the build to exist; keep the bootstrap `npm install` path. Readiness polling stays the same (socket connect).
- Validate: VJ tab loads, postMessage bridge works (audio levels move the visuals), export round-trips. Compare tab CPU/GPU in devtools performance monitor before/after.

### A2. Strip /api/jobs list payloads (audit N2)
File: `backend/server.py` (~line 1557).
- List endpoint returns id, status, progress, model_name, created_at, error, kind — NO result payloads. Add `?full=1` only if some caller truly needs it.
- Check callers first: `frontend/src/state/trainingStore.ts` (poller) + grep for `/api/jobs` usages; individual job GET (`/api/jobs/{id}`) keeps payloads, the generate flow uses that one.
- Validate: generation flow end-to-end (submit → poll → audio arrives), TRAIN view job list renders.

---

## 4. Phase B — VJ video library

### B1. Backend media entries
Files: `backend/modules/library/db.py`, `store.py`, `router.py`.
- Write `kind='video'|'image'` (column exists; no schema migration needed for the column itself; bump SCHEMA_VERSION only if adding columns — prefer storing dims/duration/thumb name in `metadata_json`).
- `POST /api/library/import-media` (multipart): accept video/* + image/* (mp4, webm, mov, png, webp, gif, jpg). Store ORIGINAL untouched at `data/generations/<uuid>/<filename>`; ffprobe duration/width/height (reuse export.py's ffmpeg discovery); render poster thumbnail `thumb.jpg` (videos: frame at 1s; images: downscaled copy; keep alpha info as a metadata flag `has_alpha` via ffprobe pix_fmt contains 'a' e.g. yuva420p/rgba).
- `GET /api/library/media/{id}` — byte-range streaming (copy the audio streamer pattern in `router.py` ~line 104), correct mime. `GET /api/library/media/{id}/thumb`.
- List endpoint: `kind` filter param so the audio tab stays clean (`/api/library/entries?kind=video`). Existing list must default to kind='audio' so nothing regresses.
- Tests: import a tiny mp4 + transparent png fixture, assert kind/mime/thumb/range-request.

### B2. Library VIDEO tab
Files: `frontend/src/views/LibraryView.tsx`, `frontend/src/state/libraryStore.ts`, `libraryEntry.ts`.
- Add `kind` to the frontend entry type; subTab `video` with thumbnail grid (poster + duration badge + alpha badge for overlay-capable media), import button (file input, multiple), remove/favorite/tags reuse.
- A11y per hard rule 3 (ids/names/labels); Tailwind v4 forms only.

### B3. VJ persistence routing
Files: `GANTASMO-LIVE-VJ/src/fileRouter.ts` (+ wherever file inputs land), `frontend/src/views/VJView.tsx` bridge.
- VJ file import: upload to `POST /api/library/import-media` (absolute URL `http://localhost:8600`, CORS already open for the sidecar origin — VERIFY: backend CORS config allows :5187), then put the returned stable `/api/library/media/<id>` URL in `videoBucket`. Blob URL only as instant preview while the upload finishes.
- Because the bucket already persists non-blob URLs, the cue then survives reloads with ZERO further work. "Unless removed" = existing bucket remove + (optionally) library delete stays independent.
- Also: Library video tab gets "Send to VJ" (reuse the SET hand-off bus with a single-item payload).
- Failure path: backend down → keep blob URL, mark clip "session only" in the UI.

### B4. Overlays
Files: `GANTASMO-LIVE-VJ/src/VideoOutput.tsx`, `types.ts`, state.
- New `overlay` slot in VJState: `{ clipId|url, kind: 'image'|'video', opacity, blend }`. Composite AFTER base+effects: `ctx.globalAlpha`/`globalCompositeOperation`, drawImage of the overlay `<video>`/`<img>`. Chrome decodes VP9/webm alpha natively; mp4 alpha (HEVC) generally does NOT decode with alpha in Chrome — document that; webm-alpha + png/webp are the supported transparent paths, opaque mp4 works with blend modes.
- UI: overlay picker fed from the same bucket (filter images + alpha-flagged videos), opacity slider, blend mode select. MIDI-mappable later.

---

## 5. Phase C — global Edit Layout (MAKE → EDIT → LEARN)

Pattern proven by MIX/DJ/TRAIN: WidgetRegistry + defaultLayout + `<ControlSurface surfaceId=... >`. Keep each conversion pixel-faithful FIRST (default layout reproduces today's arrangement), then the editing comes free (Edit Layout button, fill-adjacent, gap/snap prefs, undo, save-default).

### C1. MAKE (`surfaceId="make"`) — biggest
- Carve `AdvancedGenPanel.tsx` into pinned panels: init/inpaint strip (top), presets+controls+templates rail (left), temp/sampler knobs, hero (chimera/compare), prompt block, orb spectrograms, LoRA/name/output/quick-actions/FX rail (right).
- Pinned panels (`pinned:` ids) for everything — MAKE's widgets are complex composites, not individual knobs; panel-level rearrangement is the goal, not knob-level.
- Watch: the CREATE flow, store subscriptions, and the magenta pill/LOAD button must not remount on layout edits (keep components mounted via registry, layout only moves them).
- Respect memory `feedback_layout_invariants` + `reference_design_principles` (waveforms top, L→R flow, symmetric rails, footer transport NOT part of the surface).

### C2. EDIT (`surfaceId="edit"`)
- Retire WaveformEditor's bespoke panel sizing in favor of FrGrid splitters; timeline + track rail pinned; piano/spectrum/inspector panels movable.
- Watch: liveMixer wiring (memory `project_live_mixer`), canvas mapping under the global UI transform (getBoundingClientRect rule).

### C3. LEARN (`surfaceId="learn"`)
- Graph hero pinned with fullscreen toggle preserved (layout invariant memory), side detail panels movable.

Each phase: tsc + manual visual pass + user eyes before merge; one PR per tab.

---

## 6. Phase D — micro-perf

1. `requestVideoFrameCallback` in `VideoOutput.tsx` when a clip is the active source (fallback rAF for camera/idle).
2. Selector-ize `AdvancedGenPanel` (`useGenerateParamsStore((s) => s.field)` per field or grouped shallow selectors) + same sweep over DJView hot paths.
3. VJ recording: offer `video/webm;codecs=h264` MediaRecorder when supported (hardware encode), keep VP9 fallback; export transcoder already normalizes.
4. (Investigate-only) the global ~1.1x transform: prototype `zoom` property behind a flag; verify every canvas surface (memory `project_ui_css_transform_scale`) before any switch.

---

## 6.5. Phase E — DJ live stems finish + simple/versatile sampler & stem activation

User ask (verbatim, added after the original batch): "finish integrating the live stems in DJ, have the sampler and stem activation super simple, but versatile. Fill some of those gaps."

### Verified current state (2026-06-12)
- `frontend/src/lib/djStems.ts` — `listStems()` (cached stems via `/api/stems/{entry}` → `/api/library/stems/{id}/audio`) and `ensureStems()` (foreground `POST /api/stems/{entry}/run`, 4-stem fast default, 1.5s progress polling).
- `frontend/src/state/djEngine.ts` — D4 plumbing DONE: `loadDeckStems()` decodes N stems → per-stem gain → deck `srcBus` (frees the full buffer), `setStemGain()`, stem-mode transport parity (start/seek/loop/duration all handle `stemMode`), `teardownStems()` on track swap.
- `frontend/src/views/DJView.tsx` — per-deck stems activation calls `ensureStems` then `loadDeckStems` (~line 828), per-stem faders via `onStem` (~839); `SamplerRail` (D7, ~706): 10 one-shot pads, library-track drag-drop, persisted pad→entry map in `djSamplerStore` (`thedaw.dj.sampler.v1`), buffers re-decoded on mount, right-click clears.
- Memory `project_dj_feature` pending items that overlap: deck persistence, true real-time stems.

### Gaps to fill (candidate list; scope confirmed at green-light)
- **E1. One-touch stem activation.** Single per-deck STEMS toggle with visible states (OFF → SEPARATING n% → ON) instead of the current run-then-faders flow. Switching deck ↔ stem mode must preserve playhead position both directions (full→stems already does; verify stems→full restores the buffer instead of leaving the deck empty — today `loadDeckStems` frees `d.buffer`, so OFF requires a re-decode path).
- **E2. Pre-separation in the background.** DOWNGRADED per user 2026-06-12: "almost anything being pulled from the library should have stems already, so dont sweat that. Realtime stemming while performing would be fairly uncommon." The primary path is instant load of CACHED stems; live separation stays as the existing fallback flow, no background queue needed. E1's toggle should therefore show ON-ready (cached) vs a small "needs separation" state instead of optimistic auto-runs.
- **E3. Stem pads, not just faders.** Four big mute/solo-style toggle pads per deck (vocals/drums/bass/other) as the primary control — tap kills/restores a stem; faders remain for fine control (hold/expand). MIDI-mappable through the existing djControlMap learn flow.
- **E4. Sampler ↔ stems versatility.** Pads accept ANY source: library track (today), a deck's isolated stem, or a loop slice. Per-pad gain + one-shot/loop toggle + optional choke group. Keep the 10-pad rail layout; persistence extends `djSamplerStore` (new pad source types must round-trip the reload re-decode path).
- **E5. Deck + stem persistence.** Reload restores per-deck loaded track, stem mode, and stem levels (folds in the long-pending "deck persistence" item).
- **E6. Automix stem transitions (stretch).** Automix transitions can do stem swaps (bass-kill cross, vocal-only intro) for tracks whose stems are cached. Only after E1–E3 land.

Validation: live A/B on the rig with real separated tracks (user's eyes + ears; headless checks are insufficient). Watch VRAM/RAM — stem mode quadruples decoded buffers per deck; the 6 GB card is not the constraint here (Web Audio is CPU/RAM) but demucs separation runs on it, so never auto-separate while an SA3/Magenta generate is in flight (respect the existing GPU guards).

## 6.6. Phase F — library Opus autoconvert

User ask (2026-06-12, verbatim): "We also forgot to finish the autoconvert to opus feature (verify what features of ours can and can't use that so we don't screw ourselves). It would be very helpful as my library is getting big quickly."

State check (2026-06-12): NO partial implementation exists — `grep` for autoconvert/transcode/opusify across the repo finds nothing library-side. Opus is already a first-class format elsewhere: ytimport imports as Opus (stream-copy when possible, 192k transcode otherwise, `backend/modules/ytimport/engine.py`), delivery + effects modules export Opus (`libopus`), `backend/core/module_base.py` maps the mime, library tag reader handles `.opus`. So this phase is greenfield: convert library WAV generations to Opus (likely 192k VBR, matching ytimport's transparency choice) to reclaim disk.

**F1 — compatibility audit (MANDATORY before any conversion code).** Build the matrix of every consumer of a library entry's audio file and verify Opus-readiness empirically, not by reasoning:
- Web Audio `decodeAudioData` (player, DJ decks, live mixer, sampler pads) — expected fine, verify in OUR app.
- Stems separation (demucs sidecar) — ffmpeg-backed load, expected fine; verify the sidecar venv's torchcodec/FFmpeg path decodes Opus.
- Analysis (aubio/librosa BPM/key), waveform peaks, spectrograms — librosa needs soundfile/audioread Opus support; aubio may NOT read Opus directly. Verify each.
- MIDI transcription (basic-pitch, piano-transcription-inference) — check their loaders.
- Notation/partitura/music21 pipelines that start from audio.
- Init-audio / inpainting / chimera / remix flows that feed audio BACK into generation — lossy input changes results; these may warrant keeping WAV or decoding to a temp WAV.
- EDIT tools (49 FFmpeg edit-tool endpoints) — ffmpeg-backed, expected fine.
- Export/delivery — re-encoding lossy→lossy is a quality cliff; UI should surface "source is Opus" where relevant.
Output of F1: a table in this plan (or a follow-up doc) with VERIFIED yes/no/needs-shim per consumer, plus the decision on which consumers get a decode-to-temp-WAV shim vs. which block conversion.
**F2 — conversion mechanics (after F1).** Per-entry convert + bulk "convert older than N days / all" action, default-on toggle for NEW generations vs. keep-WAV setting, originals deleted only after a verified ffprobe pass on the new file, `metadata.json` + DB mime/size updates, stems and artifacts unaffected (separate files). Settings → Storage surface showing reclaimable space estimate.
**F3 — guard rails.** Never convert entries referenced as init/inpaint sources if F1 says lossless matters there (or always keep a flag for "this entry was lossy-converted" so generation flows can warn).

## 6.7. Phase G — global right-click routing, mic input, media optimization, DJ playlist UX, and SUGGEST expansion

User ask (2026-06-13, summarized): make essentially the whole app right-clickable, support multiselect and batch sends, fix add-to-library reliability, allow send here/there/everywhere, expose stems/delete/archive/init actions everywhere, make videos/images usable and optimized, route Cymatics into VJ, add footer mic recording and lane mic buttons/effects, make DJ playlists easier, make footer transport control the active playheads, and add more granular SUGGEST controls.

### Verified current state (2026-06-13)

- Shared right-click primitive exists: `frontend/src/components/ui/ContextMenu.tsx` + `useContextMenu<T>()`. It is already used by `LibraryView.tsx`, `LineageModal.tsx`, `ControlSurface.tsx`, `MediaBucketView.tsx`, `PianoRoll.tsx`, `StepSequencer.tsx`, and `WaveformEditor.tsx`.
- Shared send helpers exist: `frontend/src/lib/sendToTargets.ts` handles `SendableAudio`, audio → editor/init/inpaint/chimera, MIDI → piano roll / step sequencer, and stem-row → sendable audio. This is the right foundation; do not duplicate this logic in each menu.
- Mic recording exists but is local-panel oriented: `frontend/src/components/audio/MicRecorder.tsx` uses browser `getUserMedia` + `MediaRecorder`, can preview, send to editor/init/inpaint, and import into library.
- EDIT timeline is store-driven: `frontend/src/state/editorStore.ts` currently starts with one track and exposes `addTrack`, `removeTrack`, `updateTrack`, `addClipToTrack`, etc. `WaveformEditor.tsx` already supports track selection and creates a new track when a library drop lands below the last lane.
- Footer transport has partial mode-awareness: `PlayerFooter.tsx` toggles DJ master on the DJ tab and VJ playback on VJ/DJ tabs, but skip/progress behavior still mostly targets the global single-track `playerStore`.
- Library media backend exists: `backend/modules/library/router.py` supports `GET /entries?kind=audio|video|image|media|all`, `POST /import-media`, `GET /media/{id}`, and `GET /media/{id}/thumb`; `backend/modules/library/store.py` has `kind`, `media_url`, `thumb_url`, `width`, `height`, and `has_alpha` fields.
- DJ setlists exist: `frontend/src/state/setlistStore.ts` persists named sets with `create`, `rename`, `remove`, `setEntries`, `append`, `setActive`, and `setNotes`; UX is the gap.
- SUGGEST exists: `SuggestPlaylistModal.tsx` posts duration/BPM/harmonic/flow/query to `/api/library/suggest-playlist`; backend `suggester.py` sequences by BPM flow + harmonic/Camelot + query/genre.

### G0. Guard rails for this phase

- Keep this work in small PR-sized slices. Do not start “whole app right-clickable” by touching every surface at once.
- First make add-to-library reliable, then build global routing on top of it.
- Prefer one action registry over duplicated menu arrays. New context menus should consume shared actions, not reimplement send/delete/stem/archive logic.
- For implementation work, inspect the full relevant file or exact function/class sections before editing; do not rely on arbitrary partial reads.

### G1. Fix “Add to Library” and make routing reliable first

Goal: every future global send action depends on a trustworthy library import path.

Small tasks:
1. Audit every add/save/import caller before editing: `MicRecorder.tsx`, `MediaBucketView.tsx`, `LibraryView.tsx`, generated-output save paths, and any bucket/detail quick actions.
2. Verify the frontend provider import contract matches backend `/api/library/import`: multipart field names, filename, MIME type, metadata JSON, and returned `LibraryEntry` shape.
3. Add focused tests for importing an audio blob, a mic-recording blob, and a generated-output blob.
4. Make failures visible in the processing log/status UI; no silent “button did nothing” behavior.
5. Confirm the imported entry immediately appears in the library, can play, can be sent to editor/init/inpaint, and can be queued for stems/MIDI.

Success criteria: saving any generated/mic/bucket audio to library returns a new `LibraryEntry`, refreshes the UI, and can immediately play/send/stem/MIDI-convert.

### G2. Central Send/Action Registry

Goal: make the app right-clickable without duplicating menu logic.

Small tasks:
1. Create a centralized action builder, e.g. `frontend/src/lib/contextActions.ts`.
2. Define normalized payloads for: audio library entry, stem row, MIDI row, editor clip, editor track/lane, media/video/image entry, DJ setlist item, generated output, and mic recording.
3. Define shared action groups: play/preview, send to editor, send to selected/new lane, send here, send to init, send to inpaint, send to Chimera, separate stems, convert to MIDI, send to piano roll / step sequencer, send to DJ deck A/B, add to active/new DJ playlist, send to VJ, add to library, download/bundle, archive/compress, and delete.
4. Each UI component asks the registry for actions given `{ payload, selection, location }`; components should stay thin.
5. Keep `ContextMenu.tsx` as the rendering primitive and `sendToTargets.ts` as the routing foundation.

Success criteria: Library rows, EDIT clips/lanes, DJ rows, media cards, buckets, and generated outputs share consistent context actions from one implementation path.

### G3. App-wide multiselect + batch actions

Goal: support “send all to ____”, batch stem/MIDI, batch delete, and batch archive without losing selection.

Small tasks:
1. Preserve existing local selections but expose a normalized “current selection” shape to the action registry.
2. Use the Library selection behavior as the model: click single-select, Ctrl/Cmd toggle, Shift range, right-click unselected item selects it first, right-click selected item opens the batch menu.
3. Add batch wrappers for send to init/Chimera/editor, add to playlist, stem queue, MIDI queue, archive/compress, and delete with confirmation.
4. Add progress/log entries for long-running batch actions.
5. Add “selected count” headers in menus so destructive batch actions are obvious.

Success criteria: selecting 3+ items and right-clicking exposes batch-safe actions without clearing selection.

### G4. “Send here / send there / send everywhere” target model

Goal: context actions should understand where the user clicked, not only what item was clicked.

Small tasks:
1. Add a target registry for: current EDIT lane at click position, selected EDIT lane(s), new EDIT lane, Init, Inpaint, piano roll, step sequencer, DJ deck A/B, active DJ playlist, VJ bucket/feed/overlay, and Library.
2. For timeline/lane right-clicks, include `trackId`, `timeSec`, lane index, and selection state in the menu payload.
3. Extend `sendAudioToEditor()` to support specific track/lane, specific timeline time, selected lane, append-to-tail, and new-lane modes.
4. Make “Send everywhere” a submenu with explicit checked destinations, not a dangerous one-click blast.
5. Log every multi-target send with the destination list.

Success criteria: right-clicking an EDIT lane at a specific time can place imported/recorded/sent audio exactly there.

### G5. EDIT tab default lane fill (~10 lanes)

Goal: EDIT opens with enough tracks/lanes to fill the visible timeline area instead of one lonely lane.

Small tasks:
1. Add an `ensureMinTracks(count)` mutation to `editorStore.ts`; it only adds blank tracks and never auto-removes user tracks.
2. In `WaveformEditor.tsx`, measure available lane area height and compute `ceil(height / TRACK_HEIGHT)`.
3. On EDIT mount and resize, ensure at least the computed count, with a reasonable floor around 10 on normal desktop layouts.
4. Preserve existing drop-below-last-lane behavior for creating additional tracks.
5. Verify track naming/color cycling remains deterministic and readable.

Success criteria: EDIT defaults to roughly 10 visible lanes on a normal desktop screen and adapts to smaller/larger screens without deleting user-created lanes.

### G6. Footer mic input as the global record source

Goal: add a simple footer record icon and make mic recordings routable anywhere.

Small tasks:
1. Extract browser mic recording state from `MicRecorder.tsx` into a global `micInputStore` or `recordingBus` while keeping `MicRecorder` as the detailed/full UI.
2. Add a compact record icon/button to `PlayerFooter.tsx`: first click starts recording, second click stops.
3. After stop, open a compact destination menu using the shared action registry.
4. Destinations: save to library, record into Init, record into selected EDIT lane, record into lane at playhead, record into new lane, send to Inpaint, convert recording to MIDI.
5. Show recording state and elapsed time in the footer without crowding the transport.

Success criteria: footer record works globally without opening the Library mic panel first.

### G7. Track/lane mic-arm buttons + effects/stacks per lane

Goal: every track/lane can be armed for mic input and can use the existing effects/stacks.

Small tasks:
1. Add a mic-arm button to each EDIT lane header.
2. Add per-lane input mode: off, record from mic, monitor mic, record at playhead.
3. Route armed-lane recordings through the same recording bus as the footer record button.
4. Add a lane effects entry point that uses existing `effectChainStore` / effect catalog patterns.
5. Start with offline clip/lane processing or lane bounce before attempting real-time insert monitoring.
6. Only after EDIT is stable, consider DJ deck/sampler mic-arm controls.

Success criteria: a lane can be armed, recorded into, then processed with an existing effect/stack without leaving EDIT.

### G8. Vocoder integration, vendored into this repo

Goal: integrate `D:\StableAudio\JoshOG\KhoomeiVocoder` without making the app depend on that external folder after integration.

Small tasks:
1. Inspect the external vocoder source, license, model/data files, dependency footprint, and expected API before copying anything.
2. Copy only the required source/config/model assets into this repo under a clear module path such as `backend/modules/vocoder/` or `sidecars/vocoder/`.
3. Add a stable backend API: carrier audio + modulator mic/voice audio → vocoded output audio.
4. Add frontend context actions: “Use as vocoder carrier” and “Record voice as vocoder modulator”.
5. Keep it optional/lazy-loaded so normal app boot is unaffected.

Success criteria: after integration, the app still runs and vocoder still works if `D:\StableAudio\JoshOG\KhoomeiVocoder` is renamed or removed.

### G9. Make imported videos/images actually usable

Goal: imported media should have visible actions, not just storage.

Small tasks:
1. Verify the current VIDEO tab import/list/delete behavior end-to-end.
2. Add media context actions: preview, send to VJ main source, send to VJ overlay, add to active VJ set, add to DJ setlist as visual item, delete, archive/compress.
3. Add drag/drop routing from the Library VIDEO tab to VJ.
4. Show thumbnail, duration, dimensions, codec/proxy status, and alpha/overlay badges.
5. Make media entries first-class `VjSetItem` / `SetlistEntry` payloads where appropriate.

Success criteria: importing MP4/WebM/PNG/WebP creates a media card that can be previewed and sent to VJ.

### G10. Automatic video/image optimization and proxies

Goal: optimize imported media automatically without noticeable quality loss and with low playback overhead.

Codec direction:
- Opaque video playback proxy: MP4/H.264/AAC, `yuv420p`, `+faststart`, CRF roughly 20–23.
- Transparent animated overlays: WebM VP9 with alpha.
- Still images: WebP quality roughly 85–92 for most; preserve PNG/WebP/AVIF when alpha/detail needs it.
- Never flatten alpha media into opaque H.264 by accident.

Small tasks:
1. Store the original first, then enqueue a background optimization job.
2. Generate optimized playback proxy, thumbnail/poster, and metadata: width, height, duration, alpha, codec, proxy path, original path.
3. Stream the proxy by default and expose original download on demand.
4. Add settings for keep-originals, max proxy resolution, quality preset, and alpha-preserving mode.
5. Log optimization progress and show proxy status on media cards.

Success criteria: VJ uses lightweight media proxies by default while transparent overlays keep transparency.

### G11. Cymatics visualizers mixable into the VJ feed

Goal: the Cymatics/orb visualizers become VJ-mixable sources/layers.

Recommended approach: do not stream canvas pixels from the React app every frame unless unavoidable. Prefer adding Cymatics as a VJ-side visual source driven by the existing `sa3-vj/audio-levels` bridge.

Small tasks:
1. Reuse/port shader logic from `frontend/src/components/audio/CymaticsVisualizer.tsx` and `frontend/src/components/audio/cymatics/*` into the VJ app as a source module.
2. Add VJ source types: `sa3-cymatics-orb`, `sa3-cymatics-platform`, `sa3-landscape-chrome`, `sa3-landscape-ferrofluid`.
3. Drive the VJ-side source from existing `sa3-vj/audio-levels` messages.
4. Add VJ mix controls: opacity, blend mode, layer order, and audio-reactivity amount.
5. Add “Send Cymatics to VJ feed” from visualizer panels after the VJ source exists.

Success criteria: Cymatics can be layered/mixed with video in VJ without heavy per-frame cross-frame copying.

### G12. DJ playlist/setlist UX cleanup

Goal: creating, saving, adding to, and managing DJ playlists should be obvious.

Small tasks:
1. Add an always-visible active playlist strip in DJ.
2. Add quick actions: New playlist, Save current deck queue as playlist, Add selected library tracks to active playlist, Rename, Duplicate, Clear.
3. Add context actions from any track: Add to active DJ playlist, Add to new playlist, Send selected to DJ playlist.
4. Improve drag/drop into playlists.
5. Add autosave indicator and undo for accidental removals.

Success criteria: building and saving a DJ set no longer requires hunting through hidden menus.

### G13. Footer transport controls the active playheads

Goal: footer play/pause/skip/progress controls whichever surface is currently live.

Small tasks:
1. Extend `djMasterBus.ts` with commands: play/pause, previous/restart, next, seek active deck/set fraction, and report active deck/set progress.
2. In DJ mode, footer play/skip/progress uses the DJ bus, not global `playerStore`.
3. In EDIT mode, footer play/skip/progress uses the live mixer/editor bridge and updates `editorStore.playheadSec`.
4. In VJ mode, footer play/pause uses the VJ playback bus.
5. In normal mode, footer transport continues to use `playerStore`.

Success criteria: the footer controls DJ decks/set, EDIT timeline, VJ playback, or normal library playback according to the active surface.

### G14. More granular SUGGEST options

Goal: make playlist suggestion more controllable without making the basic path intimidating.

Small tasks:
1. Extend the backend request schema with optional controls: seed track, key/Camelot target, harmonic strictness, energy-curve intensity, min/max track duration, include/exclude tags, include/exclude genres, favor favorites, avoid recently played, play-count/popularity weight, discovery/randomness amount, max same-genre streak, and analyzed-only vs allow-unanalyzed.
2. Group frontend controls into Basic and Advanced sections.
3. Keep every result’s “why chosen” reason visible.
4. Add “Regenerate with more variety” and “Tighten criteria” actions.
5. Add tests for schema defaults so old callers keep working.

Success criteria: SUGGEST can generate tighter, more intentional playlists without manual library digging.

### G15. Accurate device-access errors + Quest video-in without MQDH

User ask (2026-06-13, verbatim): "fixing this bullshit to state an accurate issue like 'give the browser access to your camera, or plug in a camera'" … "lump that in with getting the quest piping video in without MQDH (if possible)".

Two related problems, one task:

1. **Actionable camera/mic errors.** Today the VJ camera toggle surfaces the raw `getUserMedia` DOMException message (`GANTASMO-LIVE-VJ/src/useMedia.ts:85` sets `err.message`, echoed to `VJView.tsx:578` as `Camera error: …`), so the user sees `Permission denied` / `Requested device not found` instead of what to DO. Map `err.name` to plain instructions across every device consumer:
   - `NotAllowedError` / `SecurityError` → "Give the browser access to your camera in the site permissions, then try again."
   - `NotFoundError` / `OverconstrainedError` → "No camera found — plug one in (or pick a different device) and try again."
   - `NotReadableError` → "The camera is in use by another app — close it and try again."
   - Audit ALL consumers, not just VJ: `MicRecorder.tsx`, VJ `useAudioAnalyzer.ts` + `VideoOutput.tsx` (mic), and the controllervision capture path. Mic errors get the same treatment ("give the browser mic access / plug in a mic").
2. **Quest video into the app without Meta Quest Developer Hub.** Research-first (feasibility uncertain). Goal: the Quest's passthrough/camera/headset view becomes a selectable VJ video source without requiring MQDH. Candidate paths to evaluate, FOSS-leaning: scrcpy (USB/Wi-Fi mirror → window → OBS virtual camera → shows up as a `getUserMedia` videoinput), WebRTC from a tiny page running in the Quest browser into the VJ app, or an OBS virtual-cam bridge. Tie-in: this is adjacent to the GANTASMO-MIDI Quest↔DAW bridge work (see memory `project_gantasmo_midi_unity`); reuse that transport if it fits. Output of the research step: a short note in this plan of the chosen path + its dependency footprint BEFORE building.

Guard rail: the VJ app lives in a separate repo working tree — the error-message fix is a separate commit there (standing constraint §7).

**Research findings (2026-06-13).** Quest video-in without MQDH is feasible; two tiers:

- **Tier 1 — rendered headset view, zero app changes to the source (RECOMMENDED first).** The Quest is Android, so `scrcpy` (FOSS, ADB over USB or Wi-Fi, no MQDH) mirrors the in-headset rendered view to a desktop window. Pipe that window through OBS → **OBS Virtual Camera**, which then appears as a normal `videoinput` device. The VJ app already takes a camera via `getUserMedia`, so the only code gap is the camera source: `GANTASMO-LIVE-VJ/src/useMedia.ts:71` hardcodes `{ facingMode: 'environment' }` with NO device picker, so it grabs the default camera and the user can't choose the OBS virtual cam. **Concrete task: add a device picker** — `navigator.mediaDevices.enumerateDevices()` → list `videoinput`s → request `{ deviceId: { exact } }`. That single change unlocks scrcpy→OBS→VJ (and any other capture device) with no Quest-side dependency beyond scrcpy+OBS.
- **Tier 2 — raw passthrough, needs Unity work.** The Quest browser cannot access the passthrough/headset cameras (no web API). Raw passthrough requires the **Quest Passthrough Camera API** (Quest 3, recent Meta SDK) inside a native/Unity app, which then streams out over WebRTC/RTSP to the VJ app as a source. This ties into the existing `GANTASMO-MIDI` Unity app (memory `project_gantasmo_midi_unity`) — reuse its transport. Bigger lift; only pursue if Tier 1's rendered view isn't enough.

Dependency footprint: Tier 1 = scrcpy + OBS (both FOSS, user-installed, no app deps) + a ~30-line device-picker change in the VJ app. Tier 2 = Unity Passthrough Camera API + a WebRTC/RTSP path. Recommend shipping Tier 1's device picker first.

## 6.8. Phase H — active incident fix: stems sidecar timeout + MIDI charmap error

User ask (2026-06-13): resolve the backend failure where library import returned 200, stems sidecar failed to write `backend_port.txt` within 300 seconds after missing `torch`/`torchcrepe`, `torchvision 0.27.0` required `torch==2.12.0` but `torch 2.11.0+cu128` was installed, and `basic_pitch` MIDI conversion failed on Windows with a `charmap` emoji encoding error.

### H1. Stems sidecar dependency/probe hardening

**Status (2026-06-13): core fix DONE.** `backend/modules/stems/sidecar.py` now probes ALL critical packages (`demucs`, `torch`, `torchaudio`, `torchcrepe`) in one subprocess via `_probe_packages()` (probe reports `packages` / `missing_critical` / `critical_ok`, keeps `demucs_importable` for back-compat). `ensure_running()` gates the pre-spawn install on `critical_ok` (not just demucs), re-probes after install to fail-fast with the missing list, and the 300s port-timeout error now names the dep state. Remaining (deferred, integration-package side): task 4 (pin torch/torchvision/torchcrepe as a compatible set), task 5 (disable run_backend.py's internal auto-install), task 7 ("Repair stems environment" Settings action).

Observed failure:

```text
background_workers: job stems:<id> failed: stems sidecar didn't write backend_port.txt within 300.0s.
Missing 2 critical package(s): torch, torchcrepe
Auto-installing missing dependencies...
torchvision 0.27.0 requires torch==2.12.0, but you have torch 2.11.0+cu128 which is incompatible.
```

Likely root cause: `backend/modules/stems/sidecar.py` currently gates pre-spawn dependency repair mostly on whether `demucs` imports. If `demucs` imports but `torch`, `torchvision`, or `torchcrepe` are missing/broken/mismatched, `run_backend.py` starts and attempts its own auto-install, then can spend the entire 300 second readiness window resolving conflicts and never write `backend_port.txt`.

Small tasks:
1. Strengthen `probe()` to check `demucs`, `torch`, `torchvision`, `torchcrepe`, and version compatibility in the dedicated sidecar venv.
2. Treat missing/broken critical packages as “deps not ready” even if `demucs` imports.
3. Run the controlled `install_dependencies()` path before spawn when critical deps are not ready.
4. Pin or filter the sidecar requirements so Torch/TorchVision/TorchCrepe resolve as a compatible set for the target CUDA/CPU mode.
5. If the integration package supports it, disable its internal auto-install and let theDAW own dependency repair.
6. Improve error diagnostics: exact package versions, import failures, install command used, return code, and `.sidecar_logs` paths.
7. Add a Settings/maintenance action or documented command: “Repair stems environment”.

Success criteria: stems sidecar either starts successfully or fails fast with actionable package diagnostics before waiting 300 seconds.

### H2. MIDI basic-pitch Windows `charmap` failure

**Status (2026-06-13): DONE.** `backend/modules/midi/engine.py` `_run_basic_pitch()` now wraps `predict_and_save()` with `contextlib.redirect_stdout/redirect_stderr` into an `io.StringIO` (a text buffer never encodes, so the library's emoji output can't trigger `UnicodeEncodeError` on cp1252), logging the captured chatter at debug. Transcription failures now report the real cause, not an output-encoding crash.

Observed failure:

```text
midi.engine: basic_pitch conversion failed for 01 - Prologue.wav: 'charmap' codec can't encode character '\U0001f6a8' in position 2: character maps to <undefined>
```

Likely root cause: on Windows, stdout/stderr may use a legacy code page such as CP1252. `basic_pitch` prints emoji/status characters; that output can crash when Python tries to encode it to the console/log stream.

Small tasks:
1. In `backend/modules/midi/engine.py`, wrap `predict_and_save()` with stdout/stderr capture or redirection using UTF-8 with replacement.
2. Set subprocess/backend environment defaults where appropriate: `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`.
3. Ensure the MIDI conversion result reports the actual transcription failure, not an output-encoding failure.
4. Add a Windows-safe smoke/regression test around `_run_basic_pitch()` logging behavior when available.

Success criteria: MIDI conversion no longer fails merely because a dependency printed an emoji/status character on Windows.

### H3. Recommended near-term order for G/H work

1. Append/maintain this plan doc only.
2. Pull **H** first because it is an active backend failure.
3. Pull **G1** second because add-to-library reliability is the base of global routing.
4. Pull **G2–G4** next as one thin vertical slice: action registry + selection + send-here for a small set of surfaces.
5. Pull **G5–G6** as visible UX wins: EDIT lane fill and footer mic button.
6. Pull media/VJ work (**G9–G11**) after routing is stable.
7. Pull DJ playlist/footer transport (**G12–G13**) after the bus contracts are clear.
8. Pull SUGGEST granularity (**G14**) after active reliability issues are fixed.
9. Pull vocoder integration (**G8**) after mic routing is stable and the external folder has been audited.

## 6.9. Phase I — stems & MIDI as first-class library items

User ask (2026-06-13, verbatim): "wtf is the point of us having stems in our library if we cant directly do anything with em? we need to treat em just like all other audio, and we can listen, delete, favorite, etc etc … We should also be able to bring our midi (and stems) that are in our library into shit and do shit with it. even use it as init audio or chimera fodder."

### I1. Stems & MIDI first-class (SHIPPED 2026-06-13)

Before: the Library STEMS and MIDI sub-tabs (`SubTabList` in `LibraryView.tsx`) rendered rows with only a right-click "send" menu — no listen, no delete, no favorite. MIDI had no audio destinations at all. Backend had no per-stem/per-MIDI delete and no favorite column.

Shipped in this slice:
- **Backend** — DB schema v5 adds a `favorite` column to `stems` and `midis`; `db.py` gains `get_stem`/`get_midi`/`set_stem_favorite`/`set_midi_favorite`/`delete_stem`/`delete_midi`. New endpoints: `PATCH`/`DELETE /api/library/stems/{id}` and `PATCH`/`DELETE /api/midi/file/{id}` (delete removes the file on disk + the row, leaves the parent track + siblings intact).
- **Frontend** — each stem/MIDI row now has an inline favorite star, play/pause (stems stream through the global engine; MIDI synthesizes first), and a delete button, plus the existing send menu extended so MIDI routes to editor/init/inpaint/chimera (synth-rendered). Favorite/delete refresh the index in place (no loading flicker) via `onMutated`.
- **Synth render** — extracted the piano-roll's offline sawtooth voice + WAV encoder into a shared, engine-shaped `frontend/src/lib/midiSynth.ts` (`renderNotesToBlob` / `renderStepNotesToBlob` / `renderMidiBufferToBlob`). PianoRoll now delegates to it, so previews, the SEND-TO-EDITOR bounce, and library MIDI all sound identical. `midiIdToSendable()` in `sendToTargets.ts` makes any library MIDI a lazy `SendableAudio`.

Caveat carried forward: MIDI audio uses the built-in sawtooth synth (no soundfont). That is the only render path until I2.

### I2. Soundfont / sample instruments + "create your own" (NEXT, not started)

User direction (2026-06-13): "download a bunch of soundfonts or samples or w/e also, maybe make a 'create your own soundfont/midi/synth' or something since we got all this other crap."

Goal: replace the sawtooth fallback with real instrument rendering and let the user build/manage their own instruments. `midiSynth.ts` is already engine-shaped so this slots in behind the same `renderNotesToBlob` surface.

Small tasks (scope-confirm at green-light):
1. Pick the render engine. Candidates: a WASM FluidSynth (`js-synthesizer`) for offline GM-soundfont (.sf2/.sf3) rendering, or a sample-based player (`soundfont-player` / pre-rendered sample packs). Favor offline-capable + bundleable (no external folder dependency, per the repo's vendoring rule).
2. Bundle/download a default GM soundfont (FluidR3_GM or similar permissive license); add a backend `instruments` store + a Settings/Storage surface for downloading more, mirroring the existing model/checkpoint download UX.
3. Define an `Instrument` abstraction in `midiSynth.ts`: `{ id, name, kind: 'synth'|'soundfont'|'sample', render(notes, opts) }`. Default stays the sawtooth; soundfont/sample engines register alongside.
4. Per-MIDI instrument pick: the row/menu lets the user choose which instrument to preview/render with (drum-channel-aware: GM channel 10 → percussion map).
5. "Create your own" builder: a small UI to define a synth patch (osc type, filter, envelope) and/or assemble a sample/soundfont instrument from imported audio (reuse the library import + stem isolation we already have — "all this other crap"). Persist user instruments; round-trip through the same render surface.
6. Optional: bake instrument choice into the auto-MIDI metadata so re-renders are deterministic.

Validation: live A/B on the rig — the user's ears decide whether soundfont output is good enough to replace the sawtooth as default; headless checks are insufficient.

## 7. Standing constraints (apply to all phases)

- Plan-before-patching: each phase gets a short proposal ping before code if scope shifts.
- NEVER `uv sync`/plain `uv run` (use `--no-sync`); new Python deps go into pyproject + `uv lock` + `uv pip install`.
- Doc/RAG edits for new features: write docs with the feature (USER_GUIDE + README), the pre-commit chain syncs/regenerates.
- A11y hard rule on every form control; Tailwind v4 canonical classes; no dropdowns where a visible status display can serve (user preference from the Settings work).
- Visual claims need the user's eyes; tsc/ruff/tests are necessary but not sufficient.
- Commits: no AI trailers. PR body style per PR #13/#14. Audit artifacts stay off-remote.
- VJ app lives in a SEPARATE repo working tree (`D:/StableAudio/GANTASMO-LIVE-VJ`) — commits there are separate from theDAW commits (check its remote before pushing).

## 8. Resume notes

Read first on resume: this plan, then `frontend/src/state/surfaceLayoutStore.ts`, `frontend/src/components/surface/ControlSurface.tsx`, `backend/modules/vj/sidecar.py`, `backend/modules/library/db.py`, `GANTASMO-LIVE-VJ/src/App.tsx` (+ `VideoOutput.tsx`), `backend/server.py` jobs endpoints. For the 2026-06-13 routing/mic/media additions, also read `frontend/src/components/ui/ContextMenu.tsx`, `frontend/src/lib/sendToTargets.ts`, `frontend/src/components/audio/MicRecorder.tsx`, `frontend/src/components/audio/PlayerFooter.tsx`, `frontend/src/state/editorStore.ts`, `frontend/src/components/audio/WaveformEditor.tsx`, `frontend/src/state/setlistStore.ts`, `frontend/src/components/library/SuggestPlaylistModal.tsx`, `backend/modules/stems/sidecar.py`, and `backend/modules/midi/engine.py`.

Open items elsewhere (not this plan): PR #19 awaiting review/visual sign-off; audit revision (judge rulings) still ON HOLD; pagefile decision pending; vertical showcase held; CRISPR punchlist open.
