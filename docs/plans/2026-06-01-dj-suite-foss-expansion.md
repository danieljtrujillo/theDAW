# theDAW → Pro DJ Suite — FOSS Expansion Plan

_Date: 2026-06-01 · Status: proposed (plan only, no code yet)_

Guideline source: the three VirtualDJ reference docs (feature taxonomy, GUI
wireframes, and the FOSS-adjacent ratings putting **Mixxx** as the only true
GPL competitor). This plan maps that taxonomy onto **theDAW's actual current
code** and lays out how to reach VirtualDJ-class DJ capability **using only
free / open-source software, libraries, and native browser APIs** — no paid
SDKs, no license fees, no watermarks.

---

## 0. Context & intent

The DJ tab today is a real-but-minimal 2-deck mixer (`state/djEngine.ts`,
shipped 2026-05-31): per-deck EQ, equal-power crossfader, turntable pitch,
play/seek/cue, plus a setlist→VJ handoff. The user wants to expand the repo
toward "as cutting-edge as possible" DJ software, modelled on the VirtualDJ
feature set, **but strictly FOSS**.

The strategic insight that drives everything below:

> **We already own the two features the docs rate VirtualDJ's strongest and
> Mixxx's weakest.** Real-time stem separation ("Excellent / FOSS Partial") —
> we have a Demucs sidecar. Video/karaoke/VJ ("Excellent / FOSS Weak — no
> comparable engine") — we have GANTASMO-LIVE-VJ embedded. Add full BPM/key
> analysis (already built) and theDAW is, on paper, the only FOSS stack that
> can rival VirtualDJ on *both* audio DJing **and** integrated visuals.

So the roadmap is not "rebuild Mixxx." It is: **close the core live-DJ-loop
gaps (beatgrid sync, loops, hotcues, key-lock, cue/headphone output, live stem
mixing, FX, set recording) and wire our existing stems + analysis + VJ into a
single performance surface** — every piece FOSS.

**Hardware stance (read first):** the 6 GB-VRAM laptop in `user_hardware` is the
**performance FLOOR, not the design target.** We build for capable machines as the
norm and **optimize preemptively** so weak machines degrade gracefully — never the
reverse. And **nothing here is deferred or called a "non-goal" without the user's
explicit approval**: where something looks expensive (notably true real-time
stems), we investigate the optimization first and bring evidence back before any
deferral. See §7.

---

## 1. Verified ground truth (what exists today)

| Capability | Status | Where (verified) |
|---|---|---|
| 2-deck audio engine | ✅ real | `frontend/src/state/djEngine.ts` — MediaElement→3-band biquad EQ→gain→djMaster→shared engine master |
| Equal-power crossfader | ✅ | `djEngine.setCrossfade` |
| Per-deck 3-band EQ | ✅ | lowshelf 120 / peaking 1k / highshelf 3.2k |
| Pitch fader | ⚠️ coupled | `playbackRate` (speed+pitch together; no key-lock) |
| Shared Web Audio engine | ✅ | `state/playerStore.ts` — one `AudioContext`, master gain + analyser; `getEngineCtx/getMasterGain/getAnalyser` |
| Live per-track mixer (EDIT) | ✅ | `state/liveMixer.ts` (just shipped) — proves the live per-source scheduling pattern |
| **Stem separation** | ✅ offline | `backend/modules/stems/` — Demucs sidecar, 2/4/6/12 stems → `data/generations/{id}/stems/*.wav`; `/api/stems/{id}/run|progress|abort`, `/api/stems/{id}` lists them |
| **BPM + beats** | ✅ | `backend/modules/analysis/` + chimera detect — aubio; `/api/analysis/{id}/run`, `/api/analysis/{id}` |
| **Musical key + scale** | ✅ | librosa chroma + Krumhansl-Schmuckler; confidence score |
| Pitch / loudness / bars | ✅ | librosa pyin + RMS + beat-derived bars |
| Waveform peaks | ✅ | `editorStore.computePeaks(blob, bins)` → Float32Array |
| **wavesurfer.js** | ✅ in use | `components/audio/WaveformPreview.tsx` (regions plugin too) — reusable for dual-deck rhythm wave |
| MIDI bus + learn | ✅ reusable | `state/midiBus.ts` (single listener → fan-out), `controllerMapStore.ts` (position→binding), `controllerProfiles.ts` (AKAI MIDIMIX etc.) |
| DJ↔VJ play/pause sync | ✅ | `state/vjPlaybackBus.ts` |
| DJ→VJ set/track handoff | ✅ | `state/vjSetBus.ts` → `sa3-vj/load-set` |
| Library + setlists | ✅ | `libraryStore.ts` (entries, `audioUrl`, search incl. BPM/key), `setlistStore.ts` (persisted) |
| Set/deck recording | ❌ | only VJ canvas export exists (`backend/modules/vj/export.py`) |
| Cue / headphone output | ❌ | no `setSinkId` anywhere |
| Loops / hotcues / sync / sampler / FX / limiter | ❌ | none in `djEngine` |
| Deck waveforms in DJ UI | ❌ | analysis+peaks exist but DJ tab shows none |
| BPM/key shown in DJ/library UI | ❌ | data computed, never surfaced |

Deps already pinned (FOSS): `librosa`, `aubio`, `torch`/`torchaudio`, Demucs
(sidecar), wavesurfer.js, zustand, React. The hard ML/DSP backend is **done**.

---

## 2. Gap analysis vs the VirtualDJ feature taxonomy (FOSS approach per row)

Legend: **HAVE** / **PARTIAL** / **GAP**. "FOSS approach" = how we close it with
zero paid software.

### Decks & playback
- Up to 4 decks — **PARTIAL** (2). FOSS: generalize `djEngine` deck map `'A'|'B'` → `'A'|'B'|'C'|'D'`; UI grows to 4. Pure refactor.
- Vinyl/CD jogwheel + scratch — **GAP**. FOSS: switch *active* decks to `AudioBufferSourceNode` (decoded) for sample-accurate scrub; jog = pointer-drag → `playbackRate`/position scrub. Native Web Audio.
- Master Tempo / key-lock — **GAP** (the one real new dep). FOSS: a WASM time-stretcher — **Signalsmith Stretch (MIT)** or **SoundTouchJS (LGPL)** in an AudioWorklet. Avoid Rubber Band (GPL/commercial dual). Decouples tempo from pitch.
- Pitch-stretch engine — **GAP** → same time-stretcher covers wide tempo ranges.
- Beatgrid + auto-BPM — **HAVE (backend)** → surface beats as a grid; align decks. No new dep (aubio).
- Key detection + harmonic mixing — **HAVE (backend)** → add a pure **Camelot wheel** mapping + "compatible key" flags in the browser. No dep.

### Mixing & control
- Central mixer (gain, 3-band EQ, filter, crossfader) — **PARTIAL** (have EQ+crossfader+gain; **add resonant filter** per deck = one `BiquadFilter` low/high-pass sweep knob). Native.
- Sync / quantize — **GAP**. FOSS: compute tempo ratio from BPMs, set time-stretch ratio, phase-align to nearest beat from the beats list. Quantize = snap loop/cue actions to beat grid. Pure logic.
- HotCues — **GAP**. FOSS: store N cue points (sec) per deck (persisted), jump on trigger. Logic + state.
- Looping (manual / auto / loop-roll) — **GAP**. FOSS: loop in/out via `AudioBufferSourceNode.loopStart/loopEnd` (active-deck buffer mode); auto-loop = beat-length loops from BPM; loop-roll = momentary. Native.
- Sampler — **GAP**. FOSS: AudioBuffer one-shot/loop bank → djMaster. Native; reuse StepSequencer voice ideas.
- Slip mode — **GAP**. FOSS: keep a "shadow" virtual playhead advancing during loop/scratch; on release, jump to it. Logic.

### Stems & FX
- **Real-time stem separation** — **HAVE (offline) → pursue BOTH tiers.**
  - *Tier 1 (ship first):* **pre-separate on library-add / on deck-load**, cache the 4 stem WAVs (Demucs already produces them), then a deck plays **4 synced stem sources with 4 gain faders**. Instant, zero-latency stem performance — and it's the docs' #1 VirtualDJ feature, matched on free software.
  - *Tier 2 (actively investigate, see §7 — NOT pre-deferred):* **true on-the-fly separation.** VirtualDJ does live stems; we should aim for it, not assume it's out of reach. FOSS paths to evaluate: (a) lighter/faster models — Demucs `htdemucs` is heavy, but **`hdemucs`/`mdx_extra_q` (quantized)**, **Open-Unmix (umxl, MIT)**, or a distilled/ONNX-exported model can run far faster, chunked; (b) **block/streaming separation** — process a rolling N-second lookahead buffer on the GPU and crossfade chunk boundaries, so "load → a few seconds → live stems" rather than full-track wait; (c) **WASM/ORT or WebGPU** inference in-browser for mid machines. A capable GPU (most users) may do near-real-time today; weak machines fall back to Tier 1 caching. Decision after the §7 spike — your call, not auto-deferred.
- Stem-aware FX — **GAP** → once a deck has 4 stem branches, an FX chain can target one branch (e.g. reverb on vocals only). Builds on stem mixing.
- Native FX (echo/flanger/filter/reverb) — **GAP**. FOSS: native nodes — `DelayNode` (echo), `BiquadFilter` (filter), `ConvolverNode` + a FOSS/CC0 impulse response (reverb), `WaveShaper`+LFO (flanger/chorus). No dep.
- Beat-aware FX — **GAP** → tie FX params (delay time, LFO rate) to detected BPM. Logic.
- Limiter — **GAP**. FOSS: `DynamicsCompressorNode` as a brickwall limiter on djMaster. Native, one node.
- Plugin SDK — **OPEN (your call)** — mirror the existing VJ plugin-registry pattern for audio FX. Sequenced after the native FX rack; flagged for a decision, not dropped.

### Hardware & I/O
- Controller support + MIDI-learn — **PARTIAL** (bus + learn store exist for SLIDE) → add a **DJ control map** reusing `controllerMapStore`/`midiBus`: bind CC/note → deck transport, crossfader, EQ, filter, hotcues, loops. No dep (Web MIDI).
- Scripting language — **OPEN (your call)** — could expose a JS macro hook later; FOSS, but big surface. Flagged for a decision, not dropped.
- DVS (timecode vinyl) — **OPEN (your call)** — hardware-specific; FOSS timecode decoding is doable in an AudioWorklet. Sequenced late, not dropped.
- Multi-soundcard routing (cue/booth) — **GAP**. FOSS: `AudioContext.setSinkId()` (baseline in the Chromium runtime theDAW renders in) + a split **main bus / cue bus**; cue bus → second context/sink for headphone pre-listen. Native browser API.

### Library & preparation
- Search by BPM/key/energy/history — **PARTIAL** (search already reads analysis JSON) → surface BPM/key/Camelot columns + filter chips in the DJ browser. Logic/UI.
- Tagging / metadata edit — **HAVE** (library tags/notes) → expose in DJ browser.
- Automix — **GAP**. FOSS: auto-sequence the active setlist, auto-beatmatch + crossfade at track tails using BPM/beats + the crossfader we already have. Logic.
- SideList / staging — **PARTIAL** (setlist sidebar) → add a "next up" staging lane distinct from the library.
- Cloud/streaming catalog — **OPEN (your call)** — VirtualDJ's hooks are proprietary, but FOSS-friendly catalogs exist (e.g. **Jamendo / Free Music Archive** open APIs, or self-hosted **Navidrome/Subsonic**). Sequenced late; flagged for a decision, not dropped.

### Video, karaoke & lighting
- Video mixing + transitions/overlays — **HAVE** (GANTASMO-LIVE-VJ) → wire DJ deck/crossfader state into VJ visuals (see §4).
- Karaoke engine — **GAP**. FOSS: parse `.lrc` lyric files (open format), render a synced lyric overlay in the VJ; optionally auto-generate timings from our vocal stem. (Sequenced in D8, not dropped.)
- DMX lighting — **GAP**. FOSS: **WebSerial/WebUSB** (native browser) → a USB-DMX widget (e.g. open Enttec-style), beat-driven cues. No paid lib. (Sequenced in D8, not dropped.)
- On-screen text / slideshow / camera — **HAVE** (VJ).

### Output & customization
- Set recording (audio) — **GAP**. FOSS: `MediaStreamDestination` off djMaster → `MediaRecorder` → save; optional backend transcode reusing the VJ export ffmpeg path. Native.
- Set recording (audio+video) — **PARTIAL** (VJ exports video) → combine with the audio record bus.
- Icecast / broadcast streaming — **GAP**. FOSS: **Icecast** server (GPL) + backend relay of the recorded stream. Out-of-process, free. (Sequenced in D8, not dropped.)
- Skin/layout tiers — **PARTIAL** (theDAW theming) → optional DJ layout presets.
- Configurable Rhythm Wave (beats/colors/shapes + gridlines) — **GAP** → render modes on the dual-deck waveform (wavesurfer + beats overlay).

---

## 3. Target architecture (the audio graph we're building toward)

Everything still hangs off the **one shared `AudioContext`** in `playerStore`
(so the visualizer/HUD see DJ audio and global volume applies), but the DJ
section grows into a proper mixer with a cue split:

```
                          ┌─ stemVocals ─ gain ─┐
 per deck (active):       ├─ stemDrums  ─ gain ─┤
   AudioBufferSource ×4   ├─ stemBass   ─ gain ─┤→ deckSum ─ filter ─ EQ(lo/mid/hi)
   (or 1 full buffer)     └─ stemOther  ─ gain ─┘                         │
                                                                          ├─ FX send/return (echo/reverb/flanger)
                                                                          │
   deckGain (fader) ── crossfader(equal-power) ──┐
                                                 ├─ djBusMain ─ limiter ─┐
   sampler one-shots ─────────────────────────── ┤                       ├─ MAIN → setSinkId(speakers) → (shared master → analyser → out)
                                                 │                       └─ RECORD tap → MediaStreamDestination → MediaRecorder
   cue-enabled decks (pre-listen) ───────────────┴─ djBusCue ── (2nd ctx) ─ setSinkId(headphones)
```

New frontend modules (names indicative; all FOSS, no code here):
- `state/djEngine.ts` — **extend**: 2→4 decks; active-deck `AudioBufferSource`
  mode for loops/scratch/stems; loop/hotcue/slip state; filter node; limiter on
  the bus; main/cue split with `setSinkId`.
- `state/djStems.ts` — load cached stem WAVs for a deck, 4 synced sources + 4
  gain faders; talks to `/api/stems/*`; triggers separation on load if missing.
- `state/djSync.ts` — beatgrid math: BPM ratio, beat phase alignment, quantize,
  automix sequencing. Pure functions over analysis data.
- `state/djFx.ts` — native-node FX chains (echo/reverb/flanger/filter), optionally
  beat-locked; per-deck or per-stem send.
- `state/djControlMap.ts` — DJ MIDI-learn reusing `controllerMapStore`/`midiBus`.
- `state/djRecorder.ts` — MediaRecorder set capture off the record tap.
- `lib/camelot.ts` — key/scale → Camelot code + compatible-key set (pure).
- `lib/timeStretch.ts` — AudioWorklet wrapper around the chosen WASM stretcher
  (key-lock / master tempo).
- VJ bridge: extend `vjPlaybackBus`/a new `sa3-vj/dj-state` message with
  crossfader + per-deck level + BPM so visuals react (closes exec-plan Phase 4).

Backend: mostly reuse. Possible small adds — an analysis/stems **auto-run on
import** hook (so tracks arrive grid-ready), and an optional audio-export
endpoint mirroring `vj/export.py` for set recordings.

---

## 4. Phased roadmap (each phase independently shippable, low→high risk)

Ordered so every phase delivers visible value and de-risks the next. Phases
1–4 need **no new dependency** — pure reuse of what's already in the repo.

**Phase D1 — Make the decks *informative* (no new deps).**
Surface what we already compute. Dual-deck **scrolling waveforms** (wavesurfer +
`computePeaks`), **BPM + musical key + Camelot** badges per deck and in the DJ
browser, beat-grid overlay on the waveforms. Auto-run analysis on library import
so tracks are grid-ready. _Outcome: the DJ tab looks and reads like a real DJ
app; foundation for sync._

**Phase D2 — Core performance loop (no new deps).**
**Hotcues** (set/jump, persisted), **loops** (manual + auto beat-loops + loop-roll),
**slip mode**. Requires moving the *active* deck to decoded `AudioBufferSource`
(hybrid: MediaElement for browse/preview, buffer for the loaded performance deck).
_Outcome: the deck can actually be performed, not just played._

**Phase D3 — Sync, key-lock & quantize (one FOSS dep: WASM stretcher).**
**Beatmatch sync** (tempo ratio + phase align), **quantize** actions to the grid,
**Master Tempo / key-lock** via Signalsmith-Stretch (MIT) or SoundTouchJS (LGPL)
in an AudioWorklet — decouples tempo from pitch at last. _Outcome: hands-free
beatmatching, the headline mixing feature._

**Phase D4 — Live stems mixing (reuse Demucs; no new dep for Tier 1).**
Per-deck **4 stem faders** playing the cached Demucs WAVs in sync; separate on
deck-load if not cached (progress UI already exists). Acapella/instrumental on the
fly. This is the marquee feature — **FOSS parity with VirtualDJ's #1 selling
point.** Includes the **D4-spike** (§7) to evaluate *true* on-the-fly separation
(faster/quantized models, streaming chunks, GPU/WebGPU) so capable machines get
live separation and weak ones fall back to cached. _Outcome: stem performance;
sets up stem-aware FX._

**Phase D5 — FX, filter & limiter (native nodes, no new deps).**
Per-deck resonant **filter** knob; **FX rack** (echo/reverb/flanger) with optional
**beat-locked** params; **stem-aware FX** routing; **DynamicsCompressor limiter**
on the bus for clip safety. _Outcome: sound design + safe output._

**Phase D6 — I/O & output (native APIs, FOSS).**
**Cue/headphone pre-listen** via main/cue bus split + `setSinkId`; **DJ MIDI-learn**
(reuse controllerMap) for transport/crossfader/EQ/filter/hotcues/loops; **set
recording** (MediaRecorder → save, optional ffmpeg transcode). _Outcome: real
gig I/O — monitor in headphones, drive from a controller, record the set._

**Phase D7 — Automation & 4 decks (no new deps).**
**Automix** (auto-sequence + beatmatched crossfade of a setlist), **4-deck** mixer,
**sampler bank**, **SideList staging**. _Outcome: full performance + hands-free
modes._

**Phase D8 — Visual & broadcast edge (mostly reuse + native APIs).**
Wire **crossfader/deck/BPM → VJ** visuals (closes Phase 4 of the older exec plan);
**karaoke** LRC overlay (auto-timed from the vocal stem); **DMX** via WebSerial;
**Icecast** relay. _Outcome: the video/karaoke/lighting edge Mixxx can't match._

A natural first shippable increment is **D1**, then **D2** — both zero-dep and
immediately make the DJ tab feel pro.

**Note on phase status:** every phase above is **planned to ship**, not optional.
Items marked "OPEN (your call)" in §2 (scripting, DVS, audio plugin SDK, cloud
catalogs) are the only ones awaiting an explicit go/no-go from you — none are
silently dropped. If anything later proves genuinely infeasible on a FOSS stack,
it comes back to you with the evidence before any deferral.

---

## 5. FOSS dependency shortlist (all free; licenses noted)

Only **one** genuinely new runtime dependency is needed for the core roadmap
(the time-stretcher); everything else is native browser API or already in-repo.

| Need | Choice | License | Notes |
|---|---|---|---|
| Key-lock / master tempo | **Signalsmith Stretch** (WASM) | **MIT** | preferred — permissive, modern, good quality |
| …alternative | SoundTouchJS / `@soundtouchjs/audio-worklet` | LGPL | proven, AudioWorklet-ready |
| …avoid | Rubber Band Library | GPL/commercial dual | skip — commercial tier not FOSS-clean |
| Waveforms | wavesurfer.js | BSD-3 | **already in repo** |
| Stems | Demucs (sidecar) | MIT | **already in repo** |
| BPM/beats | aubio | GPL-3 (backend, isolated) | **already in repo** |
| Key/pitch/loudness | librosa | ISC | **already in repo** |
| FX / filter / limiter / sampler | Web Audio API nodes | native | no package |
| Cue output / multi-out | `AudioContext.setSinkId` | native | Chromium runtime |
| MIDI | Web MIDI API | native | already used |
| DMX (stretch) | WebSerial/WebUSB | native | open USB-DMX widget |
| Reverb IR | a CC0 / public-domain impulse response | CC0 | bundle one small IR |
| Broadcast (stretch) | Icecast | GPL | out-of-process server |

No paid software, no subscriptions, no watermark — the exact failure modes the
docs flag for VirtualDJ.

---

## 6. UI / layout direction

Map the VirtualDJ wireframe (top bar → top section → waveforms → decks flanking
central mixer → pads/FX/loop row → browser + SideView) onto theDAW's existing
shell **without** breaking the layout invariants (no left panel; global bottom
dock; one library rail). Concretely, evolve `views/DJView.tsx`:

- **Top of DJ view**: master/CPU + **dual scrolling rhythm waveforms** overlaid for beatmatch (D1).
- **Decks A/B (later C/D)**: waveform + jog/scrub, transport, pitch, **BPM/key/Camelot**, **hotcue + loop pads**, **stem faders** (D2/D4).
- **Central mixer**: gain, 3-band EQ, **filter**, crossfader, **cue buttons** (D5/D6).
- **Pads/FX/loop row**: hotcues, FX rack, loop controls, **sampler** (D2/D5/D7).
- **Right sidebar**: the existing setlist becomes **browser + SideList/staging + Automix** (D1/D7).
- Reuse `ContextMenu`, the SLIDE controller-map UX, and Tailwind v4 conventions.

---

## 7. Performance strategy, spikes, and open decisions

**Hardware stance:** the **6 GB-VRAM laptop is the FLOOR, not the design target.**
Most users have more headroom, so we build for capable machines as the norm — but
we **optimize preemptively** so weak machines degrade gracefully rather than break.
The pattern throughout: detect capability, run the full path where it fits,
auto-fall-back where it doesn't, and never silently cap a feature without saying so.

**Optimization-before-deferral is the rule.** Nothing in this plan is deferred or
declared a "non-goal" without an explicit decision from the user. Where a feature
looks expensive, we investigate the optimization first and bring evidence back.

Concrete optimization levers (apply as needed, per phase):
- **Decode scope**: decode buffers only for the *active performance* deck(s); keep
  MediaElement streaming for browse/preview; free idle deck buffers.
- **Stem memory**: stems are ~4× the audio; stream/seek within stem WAVs, decode on
  demand, release stems for non-active decks; cached stems already 16-bit on disk;
  lazy-load per stem branch.
- **Tiered DSP**: a capability probe (GPU class, cores, memory) selects a tier —
  full models / higher waveform resolution / more simultaneous FX on strong
  machines; lighter models / lower res / capped FX on weak ones. Manual override
  like the VJ `performanceMode`.
- **Offload**: GPU/WebGPU/WASM where it helps (stems inference, time-stretch in an
  AudioWorklet off the main thread).
- **Reuse the VJ perf playbook** already proven in this repo: cached refs, no
  per-frame allocations, throttling, ResizeObserver, dynamic buffers.

**Spikes to run (investigate, then decide — do NOT pre-defer):**
- **D3-spike — time-stretch**: prototype **Signalsmith (MIT)** vs **SoundTouchJS
  (LGPL)** in an AudioWorklet; measure quality + CPU across tiers. Pick one.
- **D4-spike — true real-time stems**: VirtualDJ does live separation; we aim to.
  Evaluate FOSS paths — faster/quantized Demucs variants (`hdemucs`/`mdx_extra_q`),
  **Open-Unmix (umxl, MIT)**, ONNX/distilled exports, block/streaming separation
  with chunk crossfade, and GPU/WebGPU/ORT inference. Goal: live separation on
  capable machines, cached fallback (Tier 1) on weak ones. Report before settling.
- **`setSinkId` / dual-context cue**: verify in the actual runtime; if a path is
  unsupported, surface it and ask — don't silently single-output.

**Open decisions (YOUR call — flagged, not dropped):** scripting/macro hook, DVS
timecode, audio-plugin SDK, cloud/streaming catalog (FOSS sources: Jamendo, FMA,
self-hosted Subsonic/Navidrome). Each is FOSS-feasible and sequenced; they wait
only on your go/no-go.

**Honor HARD RULES**: never downgrade existing model/lib pins; ruff stays pinned;
Tailwind v4 class forms; no AI commit trailers.

---

## 7a. Controller recognition — the three tiers (built + planned)

MIDI exposes **no** standard way to read a device's physical layout from
firmware — Web MIDI gives only `input.name`/`manufacturer` strings. (MIDI 2.0
Property Exchange could, but no browser exposes it and almost no gear
implements it.) So recognition is layered, weakest assumption last:

- **Tier 1 — Library match (DONE, commit 9765611).** ~110 profiles across every
  major + niche vendor, scored by longest name match, with per-vendor fallbacks
  and generics. Instant, zero-interaction for recognized gear.
- **Tier 2 — Learn / capture (DONE, commit 9765611).** Universal: wiggle/press
  each control once; we build the EXACT layout + mapping from what the device
  actually sends. Covers any custom/combined rig (incl. the 92-control setup).
- **Tier 3 — CV-inferred layout (PLANNED, user idea 2026-06-01).** Once a device
  is name-identified (Tier 1) or partially verified, optionally **fetch a product
  image + text** and infer the spatial layout by computer vision, then present a
  pre-built, photo-accurate surface for the user to confirm. Goal: a surface that
  *looks like the real device*, not just the right control counts.

### Tier 3 design (FOSS, opt-in, evidence-gated — to spec before building)
Flow: identify device → **background image/text search** (only when Tier 1 gives
a confident vendor+model, or the user types/confirms a model) → fetch candidate
product image(s) + manual/spec text → **CV layout inference** (detect knobs =
circles/Hough, faders = elongated tracks, pads = grid of rounded rects; OCR any
labels; cross-check counts against the manual text and against Tier-2 capture if
present) → build a positioned layout (x/y/kind per control) → **user verifies**
in a confirm step (accept / nudge / fall back to Tier-1 grid) → save as a
profile (extends ControllerProfile with optional per-control x/y + image).

Honesty / guardrails (must hold):
- **Opt-in + confidence-gated.** Only runs when the user asks or a match is
  high-confidence; never auto-fires on every connect. "100% positive" = a
  product page / manual with a matching model string AND CV control-count that
  agrees with the manual (and Tier-2 capture if available) — otherwise we fall
  back to the Tier-1/Tier-2 layout and say so. No silent guessing.
- **FOSS only.** CV via a FOSS stack — OpenCV (Apache-2.0) / ONNX models, or a
  small detector — run in the **backend** (it already hosts torch/cv-capable
  Python) as a new module under `backend/modules/`, not a paid vision API.
- **Image search is the open question.** A truly FOSS, ToS-clean image+text
  source needs a decision: Wikimedia/Wikipedia API + manufacturer spec pages,
  a user-supplied photo (snap your device → CV the photo, zero search), or an
  optional user-provided search key. **This is a YOUR-CALL item** (sourcing +
  licensing), so it's flagged below, not assumed.
- **Mapping still comes from MIDI**, not the picture — CV places controls
  spatially; Tier-2 capture (or MIDI-learn) binds them to real CC/notes. CV
  makes it *look* right; MIDI makes it *work* right.

Sequenced as **D6.5 / its own track** (after the core performance loop), since
it's a backend CV module + a new confirm UI, not on the audio critical path.

**Added open decision (YOUR call):** Tier-3 image/text source — Wikimedia +
manufacturer pages, user-supplied device photo (no search), or an optional
search-API key. Pick the sourcing model before we build the CV module.

---

## 8. Verification approach (per phase)

- Each phase: `tsc -b` + `vite build` clean (both apps if VJ touched); `uv run
  ruff check . && ruff format --check .` at repo root for any backend change; no
  new IDE/Pylance warnings in touched files.
- Audio behaviour can't be fully proven headless — drive what's possible with
  **Playwright** (DJ tab mounts, controls present, no console errors, analysis
  badges populate against a running backend), then a short **manual live check**
  per phase (load two real tracks; beatmatch; loop; stem-mute vocals; cue in
  headphones; record a 30 s set) — the user runs these on the RTX-3060 laptop.
- Commit per phase on a feature branch; push to the fork (`new_origin`).

---

## 9. One-paragraph executive summary

theDAW is already most of the way to a FOSS VirtualDJ that Mixxx can't match:
the Demucs stem engine, full BPM/key analysis, a working 2-deck mixer, wavesurfer,
a MIDI-learn framework, and an embedded VJ/video engine all exist today. The gap
is the **live performance loop** — beatgrid sync, key-lock, loops, hotcues, live
stem faders, FX, cue output, and set recording — almost all of which are **native
Web Audio / browser APIs plus reuse of code we already have**, needing exactly
**one** new FOSS dependency (an MIT/LGPL WASM time-stretcher for key-lock).
Shipping phases D1→D2 first (zero new deps) makes the DJ tab feel pro immediately;
D3→D6 deliver the headline mixing features; D7→D8 add automation, 4 decks, and the
visual/karaoke edge — all on a 100% free stack.
```
