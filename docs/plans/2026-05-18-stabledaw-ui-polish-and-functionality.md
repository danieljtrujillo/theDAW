# theDAW UI — Polish & Functionality Plan

**Date:** 2026-05-18
**Status:** Triage only. No code changes performed.
**Context:** Frontend graft from `grafting_day/ui_v2/` was completed earlier today. The theDAW UI is now live on :5173 with backend shim on :8600. This doc enumerates the layout, polish, and functionality work the user identified after a first walkthrough.

---

## 0. Reading the room

Two important framings before the task list:

1. **The library persistence layer the user remembers is `libraryStore.ts`** — a client-side IndexedDB store at [frontend.bak-20260518-060200/src/state/libraryStore.ts](../../frontend.bak-20260518-060200/src/state/libraryStore.ts) (`DB_NAME = 'sa3-library'`, object store `generations`). The old `GenerateView` called `useLibraryStore.addEntry(...)` after every successful generation ([frontend.bak-20260518-060200/src/views/GenerateView.tsx:112](../../frontend.bak-20260518-060200/src/views/GenerateView.tsx#L112)). The theDAW LibraryView dropped both. Porting `libraryStore.ts` back and re-attaching the `addEntry` hook is the work — small, mostly a copy-paste.

2. **The current footer is not vertically overlapping content geometrically — it's eating real estate.** Math: `Shell` is `h-[calc(100vh-5rem)]` ([Shell.tsx:35](../../frontend/src/components/layout/Shell.tsx#L35)), `PlayerFooter` is `fixed bottom-0 h-20` ([PlayerFooter.tsx:15](../../frontend/src/components/audio/PlayerFooter.tsx#L15)). They tile cleanly. The complaint in the screenshot is that the **bottom analysis row inside the DAW panel feels cramped** because (a) the footer steals 80px from the page, (b) the bottom panel defaults to `bottomHeight=160` ([DAWCenterPanel.tsx:12](../../frontend/src/components/layout/DAWCenterPanel.tsx#L12)) of which ~30px is the tab bar, leaving ~130px of visualization, and (c) the footer duplicates the visualization at right ([PlayerFooter.tsx:81-83](../../frontend/src/components/audio/PlayerFooter.tsx#L81-L83)), making the perception of "blocking" worse. Fixing perception > fighting geometry.

---

## 1. Layout & footer issues

### 1.1 Footer's right-side mini-visualizer is redundant

**Where:** [PlayerFooter.tsx:80-83](../../frontend/src/components/audio/PlayerFooter.tsx#L80-L83)
```tsx
<div className="hidden xl:block opacity-60 hover:opacity-100 transition-opacity w-[200px] h-[50px]">
  <AdvancedVisualizer />
</div>
```
This is a *second* instance of `AdvancedVisualizer` running its own `requestAnimationFrame` loop alongside the main one in the bottom analysis panel.

**Task:** Delete that block. Drop the `AdvancedVisualizer` import line too if unused after the cut.
**Effort:** 2 minutes.
**Risk:** None — purely cosmetic deletion.

---

### 1.2 Volume slider → vertical, mounted in the spectral panel

**Where now:** Horizontal `<input type="range">` at [PlayerFooter.tsx:85-102](../../frontend/src/components/audio/PlayerFooter.tsx#L85-L102) (~80px wide, sits next to download/more-actions buttons).
**Where it should live:** Inside the spectral panel card at [DAWCenterPanel.tsx:121-152](../../frontend/src/components/layout/DAWCenterPanel.tsx#L121-L152), pinned to the right edge as a vertical fader.

**Task breakdown:**
1. Create a shared volume store (Zustand) — `usePlaybackStore` with `{volume, muted, setVolume, toggleMute}`. Both footer and spectral panel read/write this so they stay in sync.
2. Build a `<VerticalFader>` primitive that wraps `<input type="range" style="writing-mode: vertical-lr; transform: rotate(180deg);">` (or a CSS-driven custom slider). ~140px tall to fit inside the panel.
3. Leave the existing footer slider in place but switch its `useState` to the shared store so it reflects the new fader.
4. In the spectral panel, add the fader to the right edge as an absolute-positioned column inside the visualizer area.

**Effort:** 1–1.5 hours (Zustand store + vertical fader primitive + two consumer updates).
**Risk:** Web Audio volume control is wired in zero places today — the slider drives a `useState` only. So "moving" the slider is essentially "build the slider and have it set a new state." The actual *audio routing* (apply volume to playing `<audio>` element) is a separate, currently-missing piece — flag this as 1.2b below.

**1.2b — Wire volume to actual playback:** The `<audio>` tag at [GenerateView.tsx:312](../../frontend/src/views/GenerateView.tsx#L312) uses default browser controls. Once outputs route through a central player (see §3.3), set `audioElement.volume = volume / 100` reactively.

---

### 1.3 Make `bottomHeight` not feel cramped

**Where:** [DAWCenterPanel.tsx:12](../../frontend/src/components/layout/DAWCenterPanel.tsx#L12) sets `bottomHeight=160` by default. The bottom row contains the spectral panel + the processing log side-by-side ([DAWCenterPanel.tsx:117-169](../../frontend/src/components/layout/DAWCenterPanel.tsx#L117-L169)).

**Task:** After moving the log to the left column (§1.5), the bottom row becomes spectral-only and can either:
- Shrink horizontally (no log) and give the spectral more vertical room by default (bump default to ~220).
- Or, give the spectral panel the full width of the DAW center column.

Bump default `bottomHeight` to 220 and let the spectral span all 12 grid columns once the log moves out.

**Effort:** 5 minutes once §1.5 is done.

---

### 1.4 Restore handle for collapsed spectral panel — already exists, just unclear

**Where:** [DAWCenterPanel.tsx:104-113](../../frontend/src/components/layout/DAWCenterPanel.tsx#L104-L113)
```tsx
{!isBottomOpen && (
  <div className="hardware-card border-white/10 bg-black/40 flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-white/5" onClick={() => setIsBottomOpen(true)}>
     <div className="flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-purple-400" />
        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-300">Analysis & Logs</span>
     </div>
     <ChevronUp className="w-4 h-4 text-zinc-500" />
  </div>
)}
```
The restore bar IS rendered when collapsed — the user just couldn't find it. Likely it's because (a) it's only ~22px tall, (b) "Analysis & Logs" label is generic, and (c) it sits at the bottom of the DAW panel adjacent to the noisy footer.

**Task:**
- Make the bar more discoverable: brighter border, a clear pulse on the chevron, label it `[ ↑ EXPAND SPECTRAL ]` or similar, and bump height to ~30px.
- Consider a permanent corner toggle (e.g. top-right of the DAW center panel) that toggles `isBottomOpen` regardless of state, so collapse/restore is one mental affordance, not two.

**Effort:** 15 minutes.

---

### 1.5 Move processing log to the bottom of the left column (and make it real)

**Where now:** Hardcoded fake log lines, right side of the bottom row. [DAWCenterPanel.tsx:154-168](../../frontend/src/components/layout/DAWCenterPanel.tsx#L154-L168):
```tsx
<p className="border-l-2 border-purple-500 pl-2 mb-1 text-zinc-300 uppercase tracking-tighter">Engine init: successful [0x4F]</p>
<p className="pl-2.5 opacity-60">Wait for signal input...</p>
<p className="pl-2.5 space-y-1">
   <span className="block text-purple-400">Loading module: Elastique Pro v3</span>
   <span className="block text-emerald-400">Loading module: Convolution Reverb</span>
</p>
```

**Task breakdown:**
1. **New Zustand store** `useLogStore`: `{ entries: LogEntry[]; append(entry); clear(); }` where `LogEntry = { ts: number, level: 'info'|'warn'|'error'|'debug', source: string, msg: string }`. Cap at ~500 entries with a ring buffer.
2. **Wire real producers:**
   - `statusBarStore.refreshHealth` → log "API healthy" / "API unreachable (HTTP X)"
   - `generateStore.submitGeneration` → log job submit, queued, running with step counter when available, completed/failed
   - `trainingStore.refreshMetadata` → log metadata refresh result
   - `studioStore.processEffect` → log effect submitted, succeeded/failed
   - Optional: a `console.*` interceptor for errors thrown from React error boundaries
3. **New component** `<ProcessingLog />` that subscribes to the store and renders. Move it to the BOTTOM of the left panel (after `GenerateView` content), as a collapsible `<Section>` so it's a peer of the existing accordion sections. Probably anchor it as a non-collapsible final row that stays pinned ~150px tall.
4. **Delete** the right-side processing log block from `DAWCenterPanel`.
5. theDAW bottom row's grid changes from `col-span-12 lg:col-span-8` + `col-span-12 lg:col-span-4` to a single full-width spectral panel.

**Effort:** 1.5–2 hours.
**Risk:** Where to position the log inside the left column is a design call — under the per-tab content (so it changes height per tab) vs. as a global pinned strip below the tab content. I'd recommend a global pinned strip below `<AnimatePresence>` in `Shell.tsx:82-98` — it stays visible across CREATE/EDIT/TRAIN/LIBRARY.

---

### 1.6 Only the top accordion section should be open on first load

**Where:** [GenerateView.tsx:72,108,156,187,222,267](../../frontend/src/views/GenerateView.tsx) — `defaultOpen` values per section:
| Section | Current | Wanted |
|---|---|---|
| PRIMARY SYNTHESIS / PROMPT | `true` | `true` |
| MODEL & DURATION | `true` | `false` |
| SEED & BATCH | `false` | `false` |
| INIT SIGNAL / CONDITIONING | `false` | `false` |
| LORA / ADAPTIVE LAYERS | `false` | `false` |
| MASTER CONTROL | `true` | `false` *(see note)* |

**Note:** MASTER CONTROL is open by default because it contains the `[RUN GENERATION]` button — closing it hides the primary CTA on first load. Recommend either:
- (a) Move the RUN button out of the accordion so it's always visible (e.g., as a sticky bar at the bottom of the left column), then close the section.
- (b) Keep MASTER CONTROL open.

User said "only the top dropdown" — that's option (a). Should be the way to go since RUN is so central.

**Task:** Change `defaultOpen` flags, refactor MASTER CONTROL into a pinned bottom CTA + a thin accordion. Same change should apply to `LibraryView`'s sections at [LibraryView.tsx:67,120,221](../../frontend/src/views/LibraryView.tsx) — only the first should be open.

**Effort:** 30 minutes including the RUN button extraction.

---

## 2. WaveformEditor functionality

The current [WaveformEditor.tsx](../../frontend/src/components/audio/WaveformEditor.tsx) is **decoration only**. Every visible value is hardcoded:

| Element | Lines | Status |
|---|---|---|
| Track names "Synth Lead", "Transients" | [WaveformEditor.tsx:37,46](../../frontend/src/components/audio/WaveformEditor.tsx#L37) | hardcoded |
| Clip labels "Generated_Main", "Hit_02" | [WaveformEditor.tsx:42,51](../../frontend/src/components/audio/WaveformEditor.tsx#L42) | hardcoded |
| Clip waveform shape | [WaveformEditor.tsx:62-64](../../frontend/src/components/audio/WaveformEditor.tsx#L62-L64) | `Math.sin()` fake |
| Clip duration | `clip.duration` is unitless (`25` rendered as `(25/10).toFixed(1)`s in tooltip [WaveformEditor.tsx:237](../../frontend/src/components/audio/WaveformEditor.tsx#L237)) | meaningless |
| Playhead | `playhead` state never advances | static at 0 |
| Timeline ruler "0:00 → 50:00" | [WaveformEditor.tsx:146-150](../../frontend/src/components/audio/WaveformEditor.tsx#L146-L150) | hardcoded labels |
| Transport bar "00:00:12:45 / 00:01:00:00" | [WaveformEditor.tsx:269](../../frontend/src/components/audio/WaveformEditor.tsx#L269) | hardcoded |
| Region "SELECT_01 // 4.5s" | [WaveformEditor.tsx:275](../../frontend/src/components/audio/WaveformEditor.tsx#L275) | hardcoded |
| Add track | works (creates empty track) | partial |
| Mute/solo/volume/pan | works (local state) | partial |
| Drag/cut/resize clips | NO HANDLERS — the `cursor-ew-resize` divs do nothing | dummy |
| `COMMIT EDIT` button | no `onClick` | dummy |

### 2.1 Make track + clip data real

**Task breakdown:**
1. **New store** `useEditorStore`: `{ tracks: Track[], selectedClipId: string|null, playhead: number, duration: number, addTrack, removeTrack, addClipToTrack(trackId, blobUrl|libraryEntryId), updateClip(id, partial), removeClip(id), splitClipAt(id, posSec) }`.
2. Replace the local `useState` for `tracks` in [WaveformEditor.tsx:34-53](../../frontend/src/components/audio/WaveformEditor.tsx#L34-L53) with the store.
3. Each clip carries: `id, trackId, label, sourceAudioId (library entry id) OR sourceBlobUrl, startSec, durationSec, offsetIntoSourceSec, color, waveformPeaks: Float32Array | null`.
4. Render real waveform peaks: for each clip, compute peaks once (via `AudioContext.decodeAudioData` + downsample to ~200 columns) and cache in the store. The current `getWaveData(seed)` math is throwaway.
5. Track name inheritance: in `addClipToTrack`, if the target track's name was auto-generated (e.g. matches `^Track \d+$`) and has no other clips, set the track name to the clip's label. Track name input ([WaveformEditor.tsx:166-170](../../frontend/src/components/audio/WaveformEditor.tsx#L166-L170)) already exists and supports manual edits.

**Effort:** 3–4 hours (the waveform peak rendering is the chunky bit).

### 2.2 Drag, cut, resize, delete

**Task breakdown:**
1. **Drag clips horizontally:** add `onMouseDown` to the clip body (not the resize handles), capture pointer, compute pixel→seconds delta, call `updateClip({startSec})`. Snap to grid when SNAP toggle ([DAWCenterPanel.tsx:75-80](../../frontend/src/components/layout/DAWCenterPanel.tsx#L75-L80)) is on (currently SNAP is also dummy — track this as 2.2b).
2. **Drag clip between tracks (vertical):** same handler, when pointer crosses a track boundary, reassign `trackId`.
3. **Resize:** the `cursor-ew-resize` divs at [WaveformEditor.tsx:240-241](../../frontend/src/components/audio/WaveformEditor.tsx#L240-L241) need `onMouseDown` handlers that adjust `durationSec` (right handle) or both `startSec` and `offsetIntoSourceSec` (left handle, since trimming from the left also shifts the in-point into the source).
4. **Cut (split):** the toolbar already has a Scissors button at [WaveformEditor.tsx:111-113](../../frontend/src/components/audio/WaveformEditor.tsx#L111-L113) but it's purely visual. When in "cut" mode, clicking inside a clip splits it at the click position into two clips that share the same `sourceAudioId` but have adjusted `offsetIntoSourceSec` + `durationSec`.
5. **Delete:** the trash button at [WaveformEditor.tsx:132-134](../../frontend/src/components/audio/WaveformEditor.tsx#L132-L134) — wire to `removeClip(selectedClipId)`. Also bind `Delete`/`Backspace` keyboard.

**Effort:** 4–6 hours. Pointer math is the bulk of it; React 19's `useTransition` is helpful for smooth dragging.
**Risk:** Cross-track drag with track lock affordance, undo/redo (out of scope — flag for v2).

### 2.2b SNAP toggle should actually snap

[DAWCenterPanel.tsx:75-80](../../frontend/src/components/layout/DAWCenterPanel.tsx#L75-L80) renders a SNAP pill that's a static `div` — no state, no onClick. The `Snap: 1/16` chip at [WaveformEditor.tsx:119-122](../../frontend/src/components/audio/WaveformEditor.tsx#L119-L122) also doesn't do anything.

**Task:** Hoist a `snapDivision: 1/16 | 1/8 | 1/4 | off` into `useEditorStore`. Apply during drag/resize. Add a click handler + small dropdown to select the division.

**Effort:** 45 minutes once the drag math is in.

### 2.3 Playback (the COMMIT EDIT bar)

The bottom bar of the WaveformEditor contains a Play button + a Region readout + the COMMIT EDIT button. None of them do anything.

**The horizontal-scroll-blocking complaint:** the track container at [WaveformEditor.tsx:156-159](../../frontend/src/components/audio/WaveformEditor.tsx#L156-L159) uses `overflow-auto`, which gives it a native horizontal scrollbar at the bottom of the scroll area. The h-8 transport bar at [WaveformEditor.tsx:262](../../frontend/src/components/audio/WaveformEditor.tsx#L262) sits BELOW the scroll area, not on top of it — so it doesn't actually overlap the scrollbar. But the scrollbar is then directly above the transport bar with no margin, making both feel "in the way" of each other when the user reaches for one.

**Recommended fix:** Convert the WaveformEditor to use a **virtualized custom scroll** rather than native overflow. A bottom scrollbar UI made of div + drag handle (~10px tall) that sits ABOVE the transport bar, with the transport bar pinned below. Also gives us control over zoom-to-cursor behavior. Alternatively: hide the native scrollbar with `scrollbar-width: thin` + custom CSS, plus add explicit `<<` / `>>` keys to the transport bar.

**Task breakdown:**
1. **Playback:** Web Audio scheduler. For now, real playback of multi-clip composition is a significant subproject (mixing N AudioBufferSourceNodes with per-track gain/mute/solo/pan, scheduling at the right offsets). For an MVP, support **preview-single-selected-clip** only — clicking play with a clip selected plays just that clip from start. Multi-clip mixdown is a v2 feature.
2. **COMMIT EDIT:** "commit" should mean — render the current composition to a wav and save to library. Backend already has the building blocks (`pipeline.generate` for new audio, `studio/process` for ffmpeg processing). For multi-clip mixdown we'd need a new backend endpoint OR do it client-side via OfflineAudioContext. **Recommend client-side OfflineAudioContext mixdown** — no backend changes, fast, deterministic. Output a Blob, write to library.
3. **Timecode readout:** drive from the playhead state + total composition length.

**Effort:** 4–6 hours for preview playback + commit-via-mixdown. Real multi-track real-time playback is a v2 stretch (8+ hours).
**Risk:** Playback latency on Windows can be uneven; advise sticking to 48kHz Web Audio (matches the backend's sample rate).

---

## 3. Library — port `libraryStore.ts` back

### 3.1 Bring `libraryStore.ts` back from the snapshot

**Source:** [frontend.bak-20260518-060200/src/state/libraryStore.ts](../../frontend.bak-20260518-060200/src/state/libraryStore.ts) — full IndexedDB CRUD already written. The `LibraryEntry` type and accompanying `historyStore.ts` shape are also in the snapshot.

**Adaptation needed:**
- Old code stores `audioBlobUrl: string` — blob URLs don't survive a page reload (they're tied to the document's lifetime), so on reload the library entry would have a dead URL. Swap to storing `audioBlob: Blob` directly in IndexedDB; rehydrate to a fresh blob URL on `load()`. (Worth checking whether this was actually a problem in practice or whether the old code had a different rehydration path I missed — the fix is small either way.)
- Update types to match the current backend response shape (which uses `audio_base64` strings).

### 3.2 Replace the dummy LibraryView

Current [LibraryView.tsx:20-25](../../frontend/src/views/LibraryView.tsx#L20-L25):
```tsx
const [songs, setSongs] = useState([
  { id: 1, name: 'Deep_Atmosphere_01', type: 'Ambient', ... },
  ...
]);
```

**Task:** Replace the local `useState` with `useLibraryStore.getFiltered()`. Wire favorite-toggle, delete, play to the store actions. Keep the search/sort UI — it already exists, just rebind onChange handlers to `setSearchQuery` / `setSortBy` on the store.

**Effort:** 1.5 hours.

### 3.3 Auto-add generations to library

**Hook point:** [generateStore.ts:196-213](../../frontend/src/state/generateStore.ts#L196-L213) — the `status === 'completed'` branch. Right now it:
- Decodes `audio_base64` into a Blob → object URL
- Stores `lastAudioUrl` + `lastFilename`

**Insert after that block:**
```ts
const blob = base64ToBlob(resultItem.audio_base64, resultItem.mime_type || 'audio/wav');
await useLibraryStore.getState().addEntry({
  id: jobId,
  title: resultItem.filename || `gen_${Date.now()}`,
  prompt: prompt,
  // ...other params from params object
  audioBlob: blob,
  timestamp: new Date().toISOString(),
  duration: params.duration,
  // ...
});
```

This makes every completed generation a real, persistent library record.

**Effort:** 1 hour with type plumbing.
**Risk:** IndexedDB storage limits — large WAVs at 48kHz stereo are ~10MB/min. Browsers grant ~50% of disk quota, so this is fine for development, but flag for eventual GC policy (delete entries > N or older than X).

### 3.4 Library → load into editor

Once library entries are real, add a "Send to Editor" button on each library row. Clicking it calls `useEditorStore.addClipToTrack(activeTrackId || newTrack, libraryEntry.id)`.

**Effort:** 30 minutes after §2 is in.

---

## 4. Step sequencer

[StepSequencer.tsx](../../frontend/src/components/audio/StepSequencer.tsx) currently:
- Renders a 16-step × 4-track grid (interactive cells, working `toggleStep`)
- Has a BPM input that sets state but does nothing
- Play button toggles `isPlaying` state but doesn't advance `currentStep`
- Track names "Kick_Synth", "Glitch_Perc", "Atmo_Pad", "Neural_Lead" — hardcoded
- "AI AUTO-FILL" button is dummy
- "MIDI LINK ACTIVE" footer text is dummy

### 4.1 Make the clock real

**Task:**
1. When `isPlaying`, run a `requestAnimationFrame` loop (or `setInterval`) that advances `currentStep` per `60000 / bpm / 4` ms (16th notes at BPM).
2. Loop back to 0 after step 15.
3. Wrap in a small `useStepClock(bpm, isPlaying, onTick)` hook.

**Effort:** 30 minutes.

### 4.2 Make steps trigger sounds

Two paths:
- **Path A — synth tones (built-in):** Each track has a synthesized sound (sine/saw/noise). On `currentStep` advance, for any active step on a track, play a Web Audio one-shot using that track's wavetype + gain. ~2 hours.
- **Path B — sample playback (library-driven):** Each track is bound to a library entry (the "Kick_Synth" track plays library item X when fired). Drag-from-library-to-track. ~3 hours, depends on §3 being done.

**Recommended:** Path A first (proves the clock works, gives audible feedback), then layer Path B in v2.

### 4.3 Track names should be editable, not labels

Today track names are read-only `<span>`. Convert to the same `<input>` pattern used in [WaveformEditor.tsx:166-170](../../frontend/src/components/audio/WaveformEditor.tsx#L166-L170).

**Effort:** 15 minutes.

### 4.4 BPM, add-track, remove-track, pattern save

- BPM input already exists and stores state — once §4.1 wires it to the clock, it works.
- The `<Plus />` button at [StepSequencer.tsx:76](../../frontend/src/components/audio/StepSequencer.tsx#L76) has no handler — wire to `addTrack`.
- The trash icon at [StepSequencer.tsx:119](../../frontend/src/components/audio/StepSequencer.tsx#L119) has no handler — wire to `removeTrack(id)`.
- "Pattern_A01" footer label suggests pattern presets — out of scope for v1, but consider a tiny `usePatternStore` with localStorage persistence.

**Effort:** 1 hour for the wirings.

---

## 5. Misc dummy values to clean up

These won't break anything but should be on a punch list since the user flagged "filenames and descriptions of things should be real, not dummy labels":

| Where | Dummy value | Real source |
|---|---|---|
| [Shell.tsx:125](../../frontend/src/components/layout/Shell.tsx#L125) | `12ms // 48k` latency | n/a — drop or wire to AudioContext baseLatency |
| [Shell.tsx:129](../../frontend/src/components/layout/Shell.tsx#L129) | `98% OPT` buffer | drop or hide |
| [Shell.tsx:161](../../frontend/src/components/layout/Shell.tsx#L161) | `Stable Audio v3.0 RF` | leave (acceptable branding) |
| [Shell.tsx:162](../../frontend/src/components/layout/Shell.tsx#L162) | `ID: 0x4F...7D` | drop or replace with backend pid |
| [PlayerFooter.tsx:29](../../frontend/src/components/audio/PlayerFooter.tsx#L29) | `spectral_manifest_v2.wav` | bind to `useGenerateStore.lastFilename` |
| [PlayerFooter.tsx:30-32](../../frontend/src/components/audio/PlayerFooter.tsx#L30-L32) | `GEN-V3`, `0:42 // 48kHz` | bind to current playing entry duration + 48kHz |
| [PlayerFooter.tsx:67,72](../../frontend/src/components/audio/PlayerFooter.tsx#L67-L72) | progress bar at 35% | bind to playback element's `currentTime/duration` |
| [PlayerFooter.tsx:65,75](../../frontend/src/components/audio/PlayerFooter.tsx#L65-L75) | `0:14 / 0:42` | same |
| [PlayerFooter.tsx:122-123](../../frontend/src/components/audio/PlayerFooter.tsx#L122-L123) | `Auto-Enhance Active`, `Buffer: 4.2mb // Latency: 12ms` | drop |
| [GenerateView.tsx:307](../../frontend/src/views/GenerateView.tsx#L307) | `FP16 // Turbo` | replace with model + sampler name from `useGenerateStore.lastJobParams` |
| [StepSequencer.tsx:24-27](../../frontend/src/components/audio/StepSequencer.tsx#L24-L27) | Track names | user-editable per §4.3 |
| [StepSequencer.tsx:141,143,146](../../frontend/src/components/audio/StepSequencer.tsx#L141-L146) | `MIDI LINK ACTIVE`, `Clock: EXT // 48k`, `Pattern_A01` | drop or replace |
| [WaveformEditor.tsx:269,275](../../frontend/src/components/audio/WaveformEditor.tsx#L269-L275) | Timecode + region readouts | bind to editor store |
| [AdvancedVisualizer.tsx:123,127,138,141](../../frontend/src/components/audio/AdvancedVisualizer.tsx#L123-L141) | `GAIN: +2.4dB`, `PEAK: -0.1dB`, `Hardware Accelerated Engine`, `L-R SYNC` | drop or wire to live analyzer (analyzer node `getFloatTimeDomainData` → peak/RMS) |

**Effort:** ~1 hour total once playback wiring exists (§1.2b, §2.3).

---

## 5.5 Deferred bottom-band layout polish (added 2026-05-18 after first reload)

These items are about the bottom band (spectrum + log + sticky RUN CTA + footer) and the output-progress overlay. Layout math is now correct (Shell height pre-compensates for `dense-layout` zoom via `--layout-zoom` CSS var), but the user flagged a few residual issues to address later:

### 5.5.1 RUN GENERATION button must be physically attached to the top of the log

**Symptom:** With the current sticky-bottom CTA pattern, when there's enough scrollable content in the left column the RUN button stays glued to the bottom of the view (= log top). But the relationship is implicit — if anything ever changes the scroll context, the button could float.

**Task:** Replace the `position: sticky` approach with a hard structural attachment — make the RUN button a sibling of `<ProcessingLog />` in the Shell layout, rendered immediately above the log with `flex-shrink-0`. The button's bottom edge would then be guaranteed-equal to the log's top edge by flex flow, not by sticky positioning.

**Where:** [Shell.tsx:81-104](../../frontend/src/components/layout/Shell.tsx#L81-L104) (left panel structure) — pull the per-view action button out of `GenerateView` and put it just above `<ProcessingLog />`. Use a small view-specific dispatch (`activeView === 'create' && <RunButton />`, etc.) so the button surface follows the active tab without rebuilding the surrounding layout.

**Effort:** 30–45 minutes.
**Risk:** Slight — moving the button out of `GenerateView` means GenerateView's state can no longer drive it directly; the button needs to read `useGenerateStore` for `isGenerating`/`progressPct` and trigger `submitGeneration` with the GenerateView's current params (so the params state probably also needs to lift to the store, or the button reads from a `useGenerateView` store).

### 5.5.2 Output progress area must never go behind anything

**Symptom:** The Output Status Monitor card (in [GenerateView.tsx:268-316](../../frontend/src/views/GenerateView.tsx#L268-L316)) appears in the scrollable content area above the sticky CTA. When the user scrolls the left column, the progress card can scroll out of view — meaning during a generation, the user can lose sight of the progress bar.

**Task:** Pin the Output Status Monitor as a sticky/fixed element that's always visible during generation. Two options:
- (a) Make it a second sticky element above the RUN button (so the bottom of left column has: progress card pinned, then RUN button pinned, then log pinned)
- (b) Make it overlay-style, floating above the accordion content with a fixed position relative to the left panel

Option (a) reuses existing layout idioms and is preferable. Heights: progress card ~70-90px, RUN button 40px, log ~180px = ~290-310px pinned at bottom of left column. Spectrum default height should be adjusted to match (or the column heights can de-couple, since the user only asked for RUN button TOP = spectrum TOP — that math may need revisiting).

**Effort:** 1 hour.
**Risk:** Need to recompute the heights so the spectrum-vs-RUN top alignment requirement still holds. Possibly easier to just NOT require strict alignment once there are three pinned strata.

### 5.5.3 Don't fix these in the next chunk — user explicitly deferred

The user said both of the above can wait. Surface them when the relevant chunks (D/E) ship.

---

## 6. Suggested execution order

Grouped so that each chunk leaves the app in a working, demoable state:

**Chunk A — Layout polish (3–4 hours):**
1. §1.1 — delete redundant footer visualizer
2. §1.4 — make collapsed-spectral restore handle more discoverable
3. §1.6 — close all but the first accordion section, extract RUN button to a sticky CTA
4. §5 punch-list cleanup (the easy half: just delete or stub dummies that don't have real data sources yet)

**Chunk B — Real status flow (3–4 hours):**
5. §1.5 — `useLogStore` + move processing log to left column with real producers
6. §1.3 — bump default `bottomHeight` for the now-spectral-only bottom row

**Chunk C — Library reactivation (3–4 hours):**
7. §3.1 — port `libraryStore.ts` from snapshot, fix the blob-url-vs-Blob bug
8. §3.2 — replace LibraryView dummy state with real store
9. §3.3 — auto-add generations to library

**Chunk D — Volume centralization (2 hours):**
10. §1.2 — `usePlaybackStore` + vertical fader inside spectral panel
11. §1.2b — wire to actual audio element volume

**Chunk E — Editor v1 (8–12 hours):**
12. §2.1 — real track/clip data via `useEditorStore`, real waveform peaks
13. §2.2 / §2.2b — drag, cut, resize, delete, snap
14. §2.3 — preview playback + OfflineAudioContext mixdown for COMMIT EDIT
15. §3.4 — library → editor drag

**Chunk F — Sequencer v1 (3–4 hours):**
16. §4.1 — real clock
17. §4.2 path A — synth tones
18. §4.3 / §4.4 — editable names + add/remove handlers

**Stretch (later):**
- §4.2 path B — sample playback from library
- Pattern presets, multi-track real-time mixdown, undo/redo, MIDI export.

**Total scoped work: ~25–30 hours** of focused engineering, broken into ~6 demoable chunks.

---

## 7. Open questions / decisions before starting

**Decided:**
- Volume slider stays in the footer. The new vertical fader inside the spectral panel mirrors it via a shared `usePlaybackStore` (both controls show the same value).

**Still open:**
1. **MASTER CONTROL accordion — extract RUN button, or keep the section open?** I'd recommend extraction (sticky RUN button at the bottom of the left column). Confirm.
2. **Multi-track real-time playback — v1 or v2?** Recommend v2; v1 = preview selected clip + offline mixdown for COMMIT EDIT. Confirm.
3. **Step sequencer sounds — synth tones first, or library samples first?** Recommend synth tones first. Confirm.
4. **Processing log placement in left column — global pinned strip, or per-tab section?** Recommend global pinned strip ~150px tall. Confirm.


