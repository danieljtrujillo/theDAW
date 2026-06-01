# theDAW Docs + VJ/DJ/Media Reliability + Mobile Execution Plan

Date: 2026-05-30
Owner: Cline + GANTASMO
Status: Approved for execution

## Goal

Deliver a focused docs + VJ/DJ/media reliability pass so core creative workflows are real, persistent, and performance-ready:

- docs/naming cleanup and better feature narrative,
- true CAM/MEM crossfading,
- unified/persistent media bucket,
- DJ set handoff that actually loads into VJ playback,
- stacked media state retention across track switches,
- export reliability (audio + selected codec),
- major mobile usability cleanup.

## Constraints

- Use existing architecture/patterns (React + Zustand + backend modules).
- Avoid duplicate code paths for media ingestion and playback routing.
- Maintain backward compatibility for existing views/stores where possible.
- Ensure naming consistency: use `theDAW` (no extra preceding "the").

## Success Criteria

1. Docs modal/header naming and guide content reflect updated product messaging.
2. Media bucket survives refresh and tab switching with playable assets intact.
3. CAM/MEM crossfader performs actual source blend (not cosmetic slider only).
4. Center VJ dropzone and right panel bucket are one unified ingestion/store path.
5. DJ "Send SET to VJ" populates VJ footer playback queue directly.
6. Switching media tracks resumes previous state/position per track.
7. MIDI mapping supports track switch + crossfader actions.
8. VJ export writes selected codec/filetype with audio preserved into organized subfolders.
9. Mobile layout remains usable and stable across key viewport sizes.

---

## Phase 1 — Docs + Naming Cleanup

### Deliverables

- Update `docs/USER_GUIDE.md`:
  - replace title/subtitle strings,
  - remove audit-oriented paragraph,
  - rewrite top summary to highlight highest-value platform features,
  - rebuild Table of Contents to match current user-facing flows.
- Update `frontend/src/components/layout/DocsModal.tsx` labels where needed.
- Update `frontend/src/components/layout/Shell.tsx` branding text consistency where needed.

### Validation

- Docs modal loads and anchors/TOC work.
- No unintended "the theDAW" occurrences.

---

## Phase 2 — Persistent Media Bucket Foundation

### Deliverables

- Refactor `frontend/src/state/mediaBucketStore.ts`:
  - metadata/order in localStorage,
  - blob payloads in IndexedDB,
  - hydration on app boot,
  - migration/compat handling from in-memory shape.

### Validation

- Import image/video/audio, refresh browser, switch tabs; bucket and playback survive.

---

## Phase 3 — Unified VJ Ingestion (Center + Right Rail)

### Deliverables

- Ensure center “Drop videos and images here” uses same store/actions as right media panel.
- Remove any split/parallel ingest paths causing list mismatch.

### Validation

- Drop in center immediately appears in right list and vice versa.

---

## Phase 4 — CAM/MEM Crossfader Becomes Real Fade

### Deliverables

- Define authoritative crossfade state and message contract.
- Apply real gain blending in active playback/render layer.
- Bridge values to VJ side (`sa3-vj/*`) for consistent visual/media response.

### Validation

- Smooth transition CAM↔MEM with no hard switching at midpoint.

---

## Phase 5 — DJ Set Handoff Loads Into VJ Footer Player

### Deliverables

- Extend `vjSetBus` payload handling so set items feed active VJ playback queue, not archive-only behavior.
- Add ack/log feedback for loaded counts/errors.

### Validation

- "Send SET to VJ" from DJ produces immediately playable queue in VJ footer.

---

## Phase 5.5 — VJ Export UX + Codec/Audio Integrity

### Deliverables

- Replace visible "write subfolder name here" with folder icon control in export toolbar row.
- Support default export folder + optional subfolder entry flow.
- Auto-create structured subfolders for sequences (e.g., PNG sequence exports).
- Ensure export pipeline preserves audio and writes exact selected codec/filetype.
- Save each export into organized per-export subfolder naming.

### Validation

- Exported files match selected format and include audio track.
- Files land in expected folder/subfolder structure.

---

## Phase 6 — Stacked Playback + Resume State + MIDI Hooks

### Deliverables

- Keep multiple bucket media tracks alive/stacked (or warm-pooled) across switches.
- Persist/restore per-track playback state (`currentTime`, play/pause, image dwell progress).
- Add MIDI-mappable controls for next/prev/select track and crossfade.

### Validation

- Switch A→B→A resumes A from previous point.
- MIDI mapping can trigger track switching/crossfade deterministically.

---

## Phase 7 — Effects Truth Pass (Neural/MediaPipe/Depth/Volumetric/Point Cloud)

### Deliverables

- Audit each advertised effect vs actual implementation wiring.
- Implement missing execution paths or relabel where capability is unavailable.
- Add capability checks + explicit unavailable messaging.

### Validation

- Each promoted effect has reproducible output path or explicit unsupported state.

---

## Phase 8 — Mobile Cleanup (Major)

### Deliverables

- Responsive and touch ergonomics pass for VJ/DJ/shell.
- Fix header/footer overlap, overflow clipping, control hit-area issues.
- Reduce background rendering overhead for hidden tabs on mobile.
- Add manual viewport QA matrix.

### Validation

- Stable operation across common phone widths/orientations.

---

## Execution Strategy

- Ship in small sequential PR-sized commits by phase.
- Validate each phase before moving on.
- Keep instrumentation/logging for cross-tab/bridge behavior.
