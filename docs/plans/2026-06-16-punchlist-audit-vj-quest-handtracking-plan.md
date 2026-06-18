# Punchlist Audit + VJ/Quest Hand-Tracking Plan (2026-06-16)

Verified each carried-over punchlist item against the actual code via a
fan-out of read-only research agents across the VJ app
(`D:\StableAudio\GANTASMO-LIVE-VJ`), the main DAW
(`d:\StableAudio\JoshOG\stable-audio-3`), and the Unity project
(`d:\Dev\Unity\GANTASMO-MIDI`). Status tags reflect what the code shows,
not what prior memory claimed. Items marked [DONE (code)] still need the
user's eyes or a runtime/headset check before they count as truly done.

## Already shipped (was listed as open; remove from active queue)

- [DONE (code)] **delinQuest "flaky on main VJ stream"** — `useQuestCast.ts`
  now self-heals: reconnect backoff (265-285), stall watchdog (454-466),
  visibility-change recovery (468-475). No bug markers remain in the path.
  Reframe as: confirm stability live; it is no longer an open code bug.
- [DONE] **VJ layout refactor** — Resolume-style "preview" layout exists
  (`types.ts:17` layoutMode union; `VJControls.tsx:369`; ClipGrid documented
  Resolume-style). There is no literal "resoDAW" name; the layout work itself
  is done.
- [DONE] **Knobs/sliders** — `Fader` (VJControls.tsx:181-226) and `TogglePad`
  (228-250) exist and drive the effect decks.
- [DONE] **VJ UI punchlist (all sub-items)** — banks=rows (ClipGrid.tsx:14),
  wheel/ctrl-wheel scroll (123-136), SOURCE relabel (VJControls.tsx:437),
  Import Media + filetype tooltip (31-37, 665-668), drag Library->banks
  (ClipGrid 28-31 / LibraryPool 113-116), footer play/pause bidirectional
  sync (App.tsx:127-180). "Kill verbose empty-state copy" — current copy is
  already concise; the verbose text described is not present.
- [DONE (code)] **Cymatics VJ source** — committed (ee98728), `three ^0.184`
  + `@types/three` in package.json, `public/piz_compressed.exr` shipped, four
  modes (orb / cymatics / landscape-chrome / landscape-ferrofluid), wired to
  the CAM<->MEM crossfader. "Live eyes" was a label mix-up; there is no eyes
  mode. Needs the user's eyes on the four modes.
- [DONE] **DJ FOSS WASM time-stretcher** — `signalsmith-stretch ^1.3.2` in
  package.json, integrated into `djEngine.ts` with per-deck key-lock.
- [DONE (code)] **Magenta RT2** — submodule `sidecars/magenta-rt2-nvidia`,
  extended sidecar accepting text + MIDI notes + audio-style
  (`backend/modules/magenta/sidecar.py`), full frontend control set
  (`AdvancedGenPanel.tsx` notes picker, style upload, sampling knobs),
  target port 8777. Needs a WSL/NVIDIA runtime check.
- [DONE (code)] **loopMIDI-into-app** — `backend/modules/questmidi/bridge.py`
  is the loopMIDI-free path (TCP listener over adb reverse, WebSocket relay to
  the frontend midiBus). It is implemented, not a pending recommendation.
- [DONE] **Pitch/tempo detection** — `backend/modules/analysis/{key,pitch}.py`
  + tempo/beat detection in the analysis engine.

## In progress / partial

- [PARTIAL] **VJ watch-link/broadcast** — backend signaling relay + STUN/TURN
  config done (`backend/modules/broadcast/router.py`). Still to build: VJ-side
  GO-LIVE broadcaster (no `useBroadcast` hook, no toggle) and the DJ-audio
  host->iframe WebRTC hop.
- [PARTIAL] **questcast end-to-end** — backend module + sidecar committed
  (ec5f5a7); `useQuestCast.ts` and `useMedia.ts` currently have UNCOMMITTED
  edits. End-to-end headset verification is undocumented.
- [PARTIAL] **Global layout phases** — A + B1-B3 shipped (PR #21, #24). B4
  overlays: spec only, not implemented. C (MAKE/EDIT/LEARN -> ControlSurface):
  not started; panels still bespoke. D (micro-perf): not started. E (DJ): see
  below. F (Opus autoconvert): greenfield, not started.
- [PARTIAL / NEEDS RECONCILIATION] **DJ suite** — 2 decks only
  (`djEngine.ts:35` DeckId = 'A' | 'B'), not 4. D3 key-lock done; D4 stems are
  cached/offline-foreground separation, not real-time. Prior memory claims D5
  (FX rack + limiter) and D6 (cue via setSinkId) shipped; a focused search did
  not confirm those, though `effectChainStore.ts` and `djControlMap.ts` exist.
  Reconcile before relying on DJ status. Not started: D7 4-deck refactor, D8,
  deck+stem persistence (this is "E5"), true real-time stems.
- [PARTIAL] **Controller recognition CV photo layout** — `controllervision`
  module exists (classical CV: Hough circles, contour analysis) and suggests
  control counts/positions. It does NOT infer MIDI mapping (mapping stays on
  the learn-capture path). So this is partly built, not merely planned.
- [PARTIAL] **VJ library visual organizer** — LibraryPool is a basic thumbnail
  grid. A Resolume-style organizer (folders, color-coding, metadata, filter,
  in-library preview) is not started.
- [PARTIAL] **Zero-terminal onboarding** — theDAW.bat, install/setup.ps1,
  Setup-MRT2.bat, exit-code contract, and the SETUP status pill exist. Missing:
  an in-app button to actually run Setup-MRT2 (the pill is informational only),
  and setup-script tests.
- [PARTIAL / DRIFT] **RAG maintenance** — all 17 DOC_PATHS resolve. Missing
  docs for shipped features: broadcast, questcast, questmidi, cymatics, and
  stems/MIDI as first-class library items. Doc edits are approval-based; these
  are proposals only.

## Not started (accurate)

- [NOT STARTED] **Quest hand tracking** — no hand-tracking, gesture, pose, or
  MediaPipe code anywhere in the VJ or Unity projects.
- [NOT STARTED] **Quest microgestures in the "add ___" menu** — Quest
  hand-tracking thumb microgestures, to be addable in a Quest/Unity-side menu.
  Exact menu location is an OPEN QUESTION (see below).
- [NOT STARTED] **3-cam passthrough stitch** — no multi-cam / stitch /
  panorama / passthrough-compositing code. Prior plan filed Quest passthrough
  as research-only/deferred. Target output is an OPEN QUESTION (see below).
- [NOT STARTED] **Stems/MIDI I2** — soundfonts + custom-instrument builder.
  I1 (play/delete/favorite/route stems+MIDI, schema v5, shared midiSynth) is
  shipped; midiSynth is a single sawtooth synth with no soundfont loader.
- [NOT STARTED] **Library folders** — data model is flat (no folder/crate/
  collection field). One-folder-vs-crates decision still pending.
- [NOT STARTED] **Notation Phase 4 (MT3) and Phase 5 (OMR)** — both listed as
  "future" in `notation/engine.py`. "Phase 8 visuals" is not a tracked phase;
  MusicXML already renders via OSMD. Clarify what Phase 8 should be.
- [NOT STARTED] **Model streaming loader** — lazy-load + RAM-parking of models
  is done (`server.py`). No streaming loader. The crash itself is disk/pagefile
  pressure, an environment issue.
- [NOT STARTED] **2026-06-10 audit application** — 124 findings + judge rulings
  exist (`CODEBASE_AUDIT_2026-06-10.md`, `audit-reports/2026-06-10/10-judge.md`).
  Rulings have not been applied to the master doc.
- [NOT STARTED] **Opus-on-import** — Opus export support exists; library-side
  auto-conversion on import is greenfield (Phase F, F1 audit first).

## Open / unchanged

- **CRISPR DNA punchlist** — the code in `ChimeraDnaScene.tsx` reportedly
  implements all nine visual goals, but the item was listed as open, so the
  visual result does not yet match the target. Keep OPEN pending the user's
  eyes against the reference choreography. The agreed 3-wave execution plan
  lives in the punchlist memory, not a separate doc.

## Hand tracking + passthrough stitch + microgestures (Quest / Unity)

Scope answered by the user: hand interactions touch virtual knobs/sliders and
drive theDAW everywhere (VJ/DJ/edit); gestures (hand pose) and microgestures
behave like a MIDI controller, emitting a signal that the user maps in theDAW's
MIDI learn; a new GANTASMO/MIDI menu in Unity is the "add ___" surface that holds
addable input sources (gestures, microgestures, knobs, sliders, buttons,
crossfaders), each bindable through MIDI learn; gestures/microgestures render with
Meta's own gesture icons. Stitch output is a clean composite (16:9 / 17:9) of the
passthrough images sent to the VJ as a source.

### What already exists (Unity 6000.4.11f1, Meta XR SDK 203.0.0)

- Passthrough stitch is BUILT: `Assets/GantasmoPassthrough/Runtime/
  GantasmoPassthroughStitch.cs` composites the two forward RGB passthrough cameras
  (PassthroughCameraAccess Left + Right) into a 16:9 RenderTexture via homography
  reprojection + feather blend, with an in-headset preview quad and a
  `GANTASMO > Add Passthrough Stitch To Scene` menu. Its `OutputTexture` is the
  handoff point for downstream streaming (which does not exist yet).
- Microgesture API present: `OVRMicrogestureEventSource` +
  `OVRHand.GetMicrogestureType()` -> SwipeLeft/Right/Forward/Backward + ThumbTap.
- Gesture-pose system present and IMPORTED: `Assets/Samples/XR Hands/1.7.3/
  Gestures/` (StaticHandGesture + XRHandShape assets) with the matching icon set.
- Meta microgesture arrow icons in the core package
  (`OVRMicrogesturesNavigationIcons.prefab`).
- MIDI bridge: `QuestMidiSender` (framed MIDI over TCP:8765 via adb reverse),
  `MidiControlSurface` router, and `MidiKnob`/`MidiSlider`/`MidiButton` controls.
- All gameplay scripts compile into Assembly-CSharp (no asmdef), which already
  references the Meta SDK, so gesture->MIDI scripts need no assembly wiring.

### Build order

1. [DONE, compiles clean in live editor; NOT runtime-verified]
   `MicrogestureMidiSource.cs` — maps the five microgestures (per hand) to a
   momentary MIDI Note (or CC pulse) via `MidiControlSurface`, debounced, mappable
   in theDAW. Needs on-headset verification: real microgesture -> note in MIDI learn.
2. `HandPoseMidiSource.cs` — wrap the imported XR Hands `StaticHandGesture`
   (fist / palm-up / point / shaka / thumbs up-down) to emit a MIDI Note on pose
   enter, carrying the matching XR Hands icon for the menu.
3. Bring the gesture/microgesture icons into `Assets/` (from the XR Hands
   `Samples~` set and the Meta arrow icons) so the menu can show them.
4. GANTASMO/MIDI in-VR "add ___" menu: a registry + 3D panel listing addable
   input sources (gesture, microgesture, knob, slider, button, crossfader), each
   emitting MIDI for learn-mapping, persisted like `SurfaceLayoutStore`, with an
   editor menu to drop it into the QuestMIDI scene.
5. Stitch -> VJ source: encode/stream `GantasmoPassthroughStitch.OutputTexture`
   through the existing questcast/delinQuest path so it shows up in the VJ as a
   camera source.

### Stitch "3rd cam" resolved: it is the depth camera

The Quest Passthrough Camera API exposes two forward RGB cameras (Left + Right);
the "3rd cam" is the environment depth, used to make the existing two-camera
stitch reproject correctly. `EnvironmentDepthManager` ships in Meta XR Core SDK
203.0.0 and publishes `_EnvironmentDepthTexture` + `_EnvironmentDepthReprojectionMatrices`
+ `_EnvironmentDepthZBufferParams` globally.

- [DONE, compiles clean; NOT runtime/headset-verified] Depth-aware reproject:
  `PassthroughStitch.shader` now has a `GANTASMO_DEPTH_STITCH` path that replaces
  the fixed `_FocalDist` plane with the real per-pixel scene distance (sampled from
  environment depth, left/right eye per output side), so every depth lines up across
  the seam instead of only the focal plane. `GantasmoPassthroughStitch.cs` brings up
  `EnvironmentDepthManager` and flips the keyword on only while depth is flowing,
  falling back to the proven focal-plane path otherwise (toggle: `useEnvironmentDepth`).
  Needs on-headset tuning: the reconstruction approximates the virtual camera as the
  mid-eye, so seam alignment and any residual offset must be eyeballed on a Quest 3.

### Verification

All of this is Quest-side and needs the headset plus theDAW MIDI learn to confirm
end to end. In-editor compilation can be checked via the Unity MCP; runtime
behavior cannot. Nothing here is "done" until seen working on the headset.
