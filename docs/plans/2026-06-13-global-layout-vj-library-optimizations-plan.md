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

## 7. Standing constraints (apply to all phases)

- Plan-before-patching: each phase gets a short proposal ping before code if scope shifts.
- NEVER `uv sync`/plain `uv run` (use `--no-sync`); new Python deps go into pyproject + `uv lock` + `uv pip install`.
- Doc/RAG edits for new features: write docs with the feature (USER_GUIDE + README), the pre-commit chain syncs/regenerates.
- A11y hard rule on every form control; Tailwind v4 canonical classes; no dropdowns where a visible status display can serve (user preference from the Settings work).
- Visual claims need the user's eyes; tsc/ruff/tests are necessary but not sufficient.
- Commits: no AI trailers. PR body style per PR #13/#14. Audit artifacts stay off-remote.
- VJ app lives in a SEPARATE repo working tree (`D:/StableAudio/GANTASMO-LIVE-VJ`) — commits there are separate from theDAW commits (check its remote before pushing).

## 8. Resume notes

Read first on resume: this plan, then `frontend/src/state/surfaceLayoutStore.ts`, `frontend/src/components/surface/ControlSurface.tsx`, `backend/modules/vj/sidecar.py`, `backend/modules/library/db.py`, `GANTASMO-LIVE-VJ/src/App.tsx` (+ `VideoOutput.tsx`), `backend/server.py` jobs endpoints.

Open items elsewhere (not this plan): PR #19 awaiting review/visual sign-off; audit revision (judge rulings) still ON HOLD; pagefile decision pending; vertical showcase held; CRISPR punchlist open.
