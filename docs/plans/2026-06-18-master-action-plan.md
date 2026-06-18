# Master Action Plan — 2026-06-18

Consolidated list of every open / unfinished task across the three codebases
(theDAW = this repo, VJ = GANTASMO-LIVE-VJ, Quest = GANTASMO-MIDI Unity). Status
tags: **[built]** = in the working tree, compile/typecheck-verified, not yet
live-verified; **[uncommitted]** = not in version control yet; **[not started]**;
**[deferred]** = blocked on a decision; **[proposed]** = designed, not applied;
**[open bug]**.

## 0. Verify + land the stacking work (immediate)
- Headset-verify the Stitch -> VJ pipeline end to end: >=24 fps after the scene
  optimizations, hand poke/grab still works after the layer move + controller
  disable, the MIDI surface is still visible in-headset, correct colours /
  orientation. **[built, needs live test]**
- Save the Unity scene so the layer move / disabled controllers / component
  settings persist into the build.
- Live-test Worlds Collide (on-screen twin) and the DJ folder -> playlist add.
  **[built, needs live test]**

## 1. Stitch -> VJ (clean passthrough + 3D composite)
- Optional next perf lever: consolidate the apparent double hand-rendering
  (Hand Tracking building block + the rig's OVRHandVisual). **[not started]**
- Move any other 3D content (holograms) onto the `GantasmoStream` layer so it
  appears in the stream (only the MIDI surface is on it today).
- delinQuest flaky on the main stream. **[open bug]**

## 2. Two-PC / live-set connectivity (biggest)
- Two computers hooked up, both feeds mixable via the VJ or autoplay. Broadcast
  module needs host / multi-input / audio-in rework. **[not started]**
- VJ GO-LIVE broadcaster + DJ-audio host -> iframe hop + TURN (watch-link).
  Backend signaling module exists; the rest is unbuilt. **[not started]**

## 3. Quest / Unity
- MR free-roam: suppress the Guardian boundary + MRUK floor/scene-mesh collider,
  no manual Space Setup. **[proposed]**
- Hand POSE -> MIDI on the Quest (only microgestures exist today). **[not started]**
- In-VR "add ___" menu for sources / microgestures. **[planned]**
- Finish the comprehensive-rig cleanup (controllers disabled, locomotor already
  off; fuller strip optional).
- Headset-verify the earlier compile-only work: microgesture->MIDI, depth-aware
  stitch, the XR-surface material system.

## 4. theDAW feature backlog
- Soundfonts + custom-instrument builder (stems/MIDI Phase I2). **[not started]**
- Library folders / crates. **[deferred — one-folder-vs-crates decision]**
- Opus auto-convert on import. **[not started]**
- DJ: 4-deck mode (D7), D8, deck persistence, true real-time stems. **[not started]**
- Notation: Phase 4 (MT3 transcription), Phase 5 (OMR), Phase 8 (visuals).
- Magenta RT2: vendor submodule + extend sidecar (notes/audio) + full frontend.
- VJ UI punchlist: banks=rows + wheel/ctrl-wheel scroll, kill empty-state copy,
  "SOURCE" + "Import Media" + filetype tooltip, drag Library -> banks, footer
  play/pause reflects real playback. **[not started]**
- Cymatics VJ source. **[built, needs live eyes]** (needs `three` dep + EXR asset)
- VJ Resolume layout + native folder dialog. **[built, needs eyes]**
- VJ library UX: visual pass modelled on Resolume. **[research]**
- Controller recognition: CV-inferred photo layout. **[planned]**

## 5. Visual / creative
- CRISPR DNA punchlist (OPEN): hero panel backdrop, ~3-coil hero strand, full-run
  chunk lift/travel, blend-on-overlap, per-lane desync, no black rungs, water/
  leaves motion. 3-wave execution plan on file. **[open]**

## 6. Infra / maintenance
- Model-load segfault: free disk + pagefile, OR approved streaming loader.
  **[open]**
- 2026-06-10 codebase audit: 124 findings, judge rulings unapplied.
- Zero-terminal onboarding remainder: in-app surface for Setup-MRT2, setup-script
  tests.
- RAG index maintenance: periodic doc/index sanity (edits are approval-based).
