# SLIDE Tab — Phase 2 Gameplan (Sync · Mixer · Stacks)

_Last updated: 2026-05-31_

The SLIDE tab is a control surface that mirrors a connected MIDI controller's
physical layout (knobs / faders / buttons) and binds each on-screen control to
something it drives. Phase 1 (visuals) is done. Phase 2 makes the controls
**actually do things**, two-way and live.

This doc is the durable reference so we don't lose the plan between sessions.

---

## Vocabulary / where things live

| Thing | File |
|---|---|
| SLIDE UI (ROW/FOCUS/CONTROLLER views) | `frontend/src/components/layout/SlidePanel.tsx` |
| Widgets (fader/knob/pad) | `frontend/src/components/layout/TrackControls.tsx` |
| SLIDE store (content/view/bank/assignments/values/pads) | `frontend/src/state/slideStore.ts` |
| Controller profiles (AKAI MIDIMIX etc.) | `frontend/src/state/controllerProfiles.ts` |
| VISUAL↔VJ sync bus | `frontend/src/state/controlSyncBus.ts` |
| VJ control manifest (in the VJ app) | `D:/StableAudio/GANTASMO-LIVE-VJ/src/controlManifest.ts` |
| VJ↔host bridge (postMessage) | `…/GANTASMO-LIVE-VJ/src/sa3Bridge.ts` + SA3 `views/VJView.tsx` |
| Editor track model (volume/pan/mute/solo) | `frontend/src/state/editorStore.ts` |
| Multi-track playback (offline bounce today) | `frontend/src/components/audio/WaveformEditor.tsx` |
| Global player engine (HTMLAudio → master gain → analyser) | `frontend/src/state/playerStore.ts` |
| Master volume/mute | `frontend/src/state/playbackStore.ts` |

`content` = which catalog the SLIDE tab shows: **AUDIO** or **VISUAL**.
`view` = layout: **row** (all faders, paged), **focus** (fisheye carousel),
**controller** (device grid, KNOBS→FADERS→BUTTONS).

---

## Phase 2 staging

- **2A — VISUAL ↔ VJ two-way sync.** ✅ DONE (2026-05-31).
- **2B — AUDIO mixer, two-way to `editorStore`.** ⏳ IN PROGRESS. User chose the
  **editorStore two-way** option (NOT the real-time scheduler rewrite). MASTER is
  live-audible now; per-track volume/pan/mute/solo apply on next play, exactly
  like the EDIT tab works today. The scheduler rewrite ("hear a track fader move
  mid-playback") is explicitly deferred — see "2B-plus (deferred)" below.
- **2C — Custom "stack" lanes (VISUAL first).** ⏳ planned below; audio stacks later.

---

## 2A — VISUAL ↔ VJ sync (DONE, for reference)

- VJ app owns a **control manifest** (`controlManifest.ts`) built from its
  existing `midiParams.ts` (24 range controls w/ native min/max) + 14 toggles.
  Everything described in **native units**.
- Bridge messages (all `sa3-vj/*`):
  - host → VJ: `request-controls`, `control-set {key,value}`
  - VJ → host: `controls-manifest {manifest,values}`, `control-changed {key,value}`
- SA3 `controlSyncBus.ts`: `toPct`/`toNative` convert 0..100 ↔ native;
  `ingestManifest` fills `slideStore.visualControls` + seeds values;
  `applyFromVj` writes inbound (guarded); a module-level `slideStore.subscribe`
  emits outbound on `visual/` changes. **Echo guard** = `applying` flag.
- `SlidePanel` VISUAL catalog = `slideStore.visualControls` (live) with the
  hardcoded `VISUAL_CATALOG` only as a pre-connect fallback.

**Known small limitation:** a manifest *toggle* rendered as a *fader* (in
row/focus) won't visually reflect inbound changes (toggles update `pads`, not
`values`). Toggles belong in controller-mode pad sections; ranges are the core.

---

## 2B — Full AUDIO mixer (real-time)

### Reality of the current audio path
- `editorStore.tracks[]` is the **canonical** mixer model: each track has
  `volume (0..1)`, `pan (-1..1)`, `mute`, `solo`. The EDIT tab's faders already
  write here via `updateTrack` / `toggleSolo`.
- **MASTER is already live**: `playbackStore.volume` → `playerStore.setMasterGain`.
- **Multi-track mixing is OFFLINE today**: `WaveformEditor.playEditorTimeline()`
  bounces every track (per-track `gain → stereoPanner → destination`, honoring
  mute/solo) into one WAV via `OfflineAudioContext`, then plays that through the
  footer's single `HTMLAudioElement`. So a per-track fader only changes the mix
  on the **next play**, not mid-playback.

### Decision (user): two-way to `editorStore` (no scheduler rewrite)
SLIDE becomes a second control surface for the mixer the app already has. No new
audio scheduling — we drive the existing `editorStore` track model + live master.

### Design — `audioMixerBus.ts` (new, `frontend/src/state/`)
Mirrors `controlSyncBus`'s shape (echo guard + module-level subscribe).
- **Live AUDIO catalog** = `['MASTER', ...editorStore.tracks.map(name)]`,
  recomputed when tracks change. Replaces the hardcoded `AUDIO_CATALOG` (kept
  only as an empty-project fallback). Resolution by lane label → track id.
- **Outbound (SLIDE → mixer):** module-level `slideStore.subscribe` watches
  `audio/` value+pad changes (skip while `applying`):
  - fader (0..100) → `MASTER`: `playbackStore.setVolume(v)` (LIVE, audible now);
    track: `editorStore.updateTrack(id,{volume:v/100})`.
  - knob (0..100) → track `pan` = `v/50 - 1` (→ -1..1) via `updateTrack`.
  - pad → track `mute` via `updateTrack`; a SOLO pad → `editorStore.toggleSolo`.
- **Inbound (mixer → SLIDE):** subscribe to `editorStore` + `playbackStore`,
  write `slideStore` audio values/pads under the `applying` guard. Because
  `editorStore` is the **single source of truth**, the EDIT-tab faders and SLIDE
  faders can never fight — both read/write the same store.
- **Param → control-kind:** in CONTROLLER view, the section kind decides (faders
  = volume, knobs = pan, pads = mute / a SOLO row). In ROW/FOCUS (all faders),
  faders = volume; pan/mute/solo are reachable in controller view.

### Honesty about "live"
- **MASTER** lane is genuinely real-time (drives `setMasterGain`).
- **Per-track** volume/pan/mute/solo write `editorStore`; today multi-track
  audio is an **offline bounce on play**, so per-track changes take effect on the
  **next play** — identical to how the EDIT tab behaves now. The SLIDE UI
  reflects them immediately (store is live); only the *audio* waits for replay.
  The lane mapping/labels make this unambiguous; no fake "live" promise.

### 2B-plus (deferred — needs explicit go-ahead)
Real-time per-track scheduler (`liveMixer.ts`: per-track
`AudioBufferSource → gain → stereoPanner → busGain → master`, transport, live
param ramps) so track faders are audible mid-playback. This rewrites proven EDIT
playback; keep the offline bounce for export. NOT in this pass.

### Acceptance (2B as chosen)
- Open a multi-track editor project → SLIDE AUDIO auto-shows MASTER + each track
  by name. Move MASTER → global volume changes **live**. Move a track fader →
  the EDIT fader moves too and the change is heard on next play. Pan knob writes
  pan; mute/solo pads write mute/solo; all reflected in EDIT. Empty project →
  MASTER + a friendly "no tracks" fallback.

---

## 2C — Custom "stack" lanes (VISUAL first)

### Concept
A **stack** is a single SLIDE lane the user assigns:
- a **media** item — image / video / audio (from the VJ bucket / media bucket), and
- **one or more effects** to drive.
The lane's slider then drives the bound effect(s) (and loads the media into the
VJ). It's a saved, reusable macro lane — "this fader = my BLOOM+GLITCH look on
clip X".

### Data model (add to `slideStore.ts`, persisted)
```ts
interface StackBinding {
  id: string;
  name: string;                 // user label shown on the lane
  media?: { kind:'image'|'video'|'audio'; url:string; label:string; entryId?:string } | null;
  targets: Array<{              // one or more effect params the slider drives
    key: string;                // VJ manifest control key
    // map the lane's 0..100 onto a sub-range of the target (so one slider can
    // push BLOOM 0..100 while GLITCH only rides 0..40, etc.)
    fromPct?: number; toPct?: number;
  }>;
  curve?: 'linear'|'exp'|'log'; // response shaping (optional)
}
// slideStore: stacks: StackBinding[]; + CRUD actions; persisted.
```

### UX
- A stack lane renders like a normal fader but flagged (badge/border) as a
  stack, titled with the user's name.
- An **assign popover** (gear on the lane): pick media (from buckets), add/remove
  target effects, set each target's sub-range, name the stack.
- Auto-fill rule: stacks occupy explicit slots (like a locked assignment) so
  auto-fill never overwrites them. Reuse the existing `assignments` lock concept.

### Drive path (reuse 2A)
- On slider move: for each target, map lane 0..100 → target sub-range →
  `controlSyncBus` native → `sa3-vj/control-set`. (No new protocol needed.)
- On stack activate/select: if it has media, push it to VJ via the existing
  `vjSetBus.sendTrackToVj` / `sa3-vj/load-*` path.
- Inbound: a stack is a "fan-out" (one→many), so inbound VJ changes don't map
  back cleanly to a stack slider; v1 is **outbound-drive only** for stacks (the
  individual effect lanes still reflect inbound). Document this.

### Audio stacks (LATER — explicitly deferred)
Same model but `targets` point at audio effect params / track sends once the
audio effect path exists (depends on 2B + an audio insert/send chain). Capture
here so we don't forget; do NOT build yet.

### Acceptance (VISUAL stacks)
- Create a stack "DREAMY" = clip A + (BLOOM 0..100, FEEDBACK 0..60). Drag its
  slider → both effects move in their ranges and clip A is loaded in VJ. Stack
  persists across reload and survives auto-fill.

---

## Build order checklist
- [x] 2B-1 `audioMixerBus.ts` — live AUDIO catalog from editorStore + MASTER, echo-guarded
- [x] 2B-2 SlidePanel AUDIO wiring (faders=volume, knobs=pan, pads=mute/solo; MASTER live)
- [x] 2B-3 inbound subscribe (editorStore + playbackStore → slideStore, guarded)
- [ ] DEFERRED 2B-plus real-time scheduler (`liveMixer.ts`) + bridge repoint
- [x] 2C-1 `StackBinding` model + slideStore CRUD (persisted)
- [x] 2C-2 stack lane rendering + assign popover (media + targets + sub-ranges)
- [x] 2C-3 stack drive via controlSyncBus (outbound fan-out) + media load via vjSetBus
- [ ] LATER audio stacks; inbound stack reconciliation; curve shaping UI

## Implementation notes (2026-05-31, as built)
- **2B** — `frontend/src/state/audioMixerBus.ts`: `audioCatalog()` = `['MASTER',
  ...editorStore tracks]`; outbound `slideStore.subscribe` on `audio/*` →
  `playbackStore.setVolume` (MASTER, live) / `editorStore.updateTrack` (vol/pan)
  / `toggleSolo`; inbound `startAudioMixerSync()` mirrors editorStore +
  playbackStore → slideStore under an `applying` guard, with a `mixerSignature`
  diff so the editor's per-frame playhead ticks don't rewrite lanes. Pan uses a
  `PAN_SUFFIX` ('… PAN') store key so a track's fader (volume) and knob (pan)
  don't collide. SlidePanel: AUDIO catalog now live; AUDIO knobs suffix-routed
  to pan; `startAudioMixerSync()` mounted once.
- **2C** — `slideStore`: `StackBinding {id,name,media,targets[]}`,
  `STACK_PREFIX='stack:'`, CRUD (`addStack/updateStack/removeStack`), persisted.
  `controlSyncBus`: `driveStackByPct` fans lane 0..100 onto each target's
  [fromPct,toPct] sub-range; `loadStackMedia` → `vjSetBus.sendTrackToVj`;
  `refreshStack` re-emits after edits. SlidePanel: stacks prepend the VISUAL
  catalog (label `stack:<id>`); `StackLane` renders a `TrackFader` (displayLabel
  = stack name) + STACK badge + gear → `StackEditor` popover (name, media from
  mediaBucket, targets with key + from/to %); "+ Stack" toolbar button (VISUAL
  only). Outbound-only (one→many can't reconcile inbound).
- Both apps: `tsc --noEmit` clean, `vite build` clean. NOT yet live-smoke-tested
  (no dev server running at build time) — user to verify in the running app.
