# Session status — pre-compaction snapshot (2026-05-28)

**Branch:** `wip/pre-torchcodec-checkpoint`
**Remote:** `new_origin` (gantasmo/StableDAW)
**VJ project:** `D:/StableAudio/GANTASMO-LIVE-VJ` on `main`

User asked for this note before context compaction so future-me
knows the precise state.

---

## Active plan: the "Revised Implementation Plan"

Six phases. **A and B fully shipped & pushed; C half-shipped.** D, E,
and DJ tab not started.

### Phase A — globalize bottom dock ✅ shipped `ff8724e`
- BottomMultiTabPanel extracted from DAWCenterPanel into its own file
  (`frontend/src/components/layout/BottomMultiTabPanel.tsx`).
- Shell.tsx has a new `<ShellBottomDock />` footer: BottomMultiTabPanel
  (left, flex-1) + ProcessingLog (right, width = rightPanelWidth).
- Single resize handle at the top drags `bottomHeight` (already in
  `useBottomPanelStore`) — both panels follow in lock-step.
- ProcessingLog refactored: Section-style header at top, body fills
  flex-1, action button always pinned at the bottom. `isLogOpen` now
  in the shared store (was local useState).

### Phase B — global Web MIDI + iframe allow=midi ✅ shipped `e10c8af`
- `frontend/src/components/audio/PianoRoll.tsx` exports
  `triggerPianoNoteFromMidi(midi, vel, dur)` — thin wrapper with sane
  defaults around the existing module-local triggerPianoNote.
- `frontend/src/App.tsx` instantiates `navigator.requestMIDIAccess()`,
  attaches `onmidimessage` to every input, on note-on (status 0x90,
  velocity > 0) calls triggerPianoNoteFromMidi. Hot-plug aware. Logs
  to LOG panel on init.
- `frontend/src/views/VJView.tsx` iframe `allow=` now includes `midi`.

### Phase C — VJ MIC/AUDIO/MIDI buttons + postMessage ⚠️ HALF-SHIPPED
**SA3 side is in the working tree but NOT YET COMMITTED.** Files modified:
- `frontend/src/views/VJView.tsx`:
  - Added `vjInputs: { mic, audio, midi }` state (all true by default)
    + `toggleVjInput` with min-1 invariant.
  - Two new useEffects: forwards input state on every change via
    `sa3-vj/inputs` postMessage; forwards every raw MIDI message via
    `sa3-vj/midi` when MIDI input is enabled (independent of the
    App-level synth trigger — both fire simultaneously).
  - Three indicator spans replaced with `<InputChip />` buttons
    (clickable, min-1 enforced via `disabled`). InputChip helper
    component defined at the bottom of the file.

**VJ project side is committed locally as `620c2b3` but DID NOT PUSH —
remote has diverged.** The remote `origin/main` has refactored App.tsx
with `videoBucket`, `layoutMode` (standard/split/preview/fullscreen),
`apConfig.timecode`, etc. My commit modifies useMidi.ts which the
remote `main` has DELETED. Rebase shows conflict:
`CONFLICT (modify/delete): src/useMidi.ts deleted in HEAD and modified
in 620c2b3`.

My commit `620c2b3 phase C: SA3 input mutes + forwarded MIDI` lives
locally at `D:/StableAudio/GANTASMO-LIVE-VJ`, on top of `861ab7e`
(my last pushed VJ commit). The remote went a different direction.

**Decision needed from user:** how to reconcile.
- Option 1: cherry-pick `620c2b3`'s logic into the new App.tsx
  structure (which has videoBucket / layoutMode). The bridge plumbing
  (`sa3Bridge.ts` changes + `useMidi.ts` if it still exists, or
  whatever replaced it) needs to land on top of the user's refactor.
- Option 2: reset our local main to match origin and re-do the SA3
  bridge wiring on the new code.
- Option 3: skip VJ-side input mute support for now; SA3 still posts
  the messages but the VJ side ignores them until reconciled.

The SA3-side commit (when made) will be functionally complete on its
own — `sa3-vj/inputs` and `sa3-vj/midi` postMessages will fire,
they'll just be no-ops on the VJ side until the bridge listeners are
re-added there.

### Phase D — Library redesign (not started)
- Rename "Media Bucket" → "MEDIA" everywhere.
- New VIDS + PICS sub-tabs in LibraryView fed from MEDIA store.
- Stats badges (entries / size / duration) move directly under the
  search input.
- LIBRARY header gets the CenterTabBar-style centered look.
- Rename "Duration" → "LENGTH" (label + column + sort tag).
- Sort tags (FAVS / NEWEST / LENGTH / TITLE) move beneath the sub-tab
  bar.
- Strip icons from TRACKS / STEMS / MIDI headers.
- Remove the GRAPH lineage button (use LEARN tab instead).
- Remove the MIC button from Library (moves to EDIT + VJ).

### Phase E — MIX cleanup + EDIT polish (not started)
- StudioView.tsx: remove STUDIO MACROS + INSERT EFFECTS sections
  (user-confirmed cleanup — PARAMETERS+OUTPUT covers it).
- Rename SELECTED PARAMS → PARAMETERS.
- AdvancedEditorPanel.tsx: side-by-side tabbed bottom dock with
  PARAMETERS (left) + OUTPUT (right).
- Apply `max-w-4xl mx-auto w-full` to StudioView + AdvancedEditorPanel
  so they don't stretch ultra-wide.
- Mount MicRecorder in WaveformEditor (EDIT tab) and VJView.

### Phase F — DJ tab + VJ SET integration (not started)
- New `dj` tab in `CENTER_TABS` (appUiStore).
- VirtualDJ-style 2-deck UI with EQ/sync/pitch/crossfader.
- `useSetlistStore` (localStorage) for saved setlists.
- VJ renames PLAYLIST → SET.
- VJ adds 2 video timelines (Deck A / Deck B).
- VJ adds central SET button with "Import Set" / "Import Track(s)"
  prompt — "Import Set" reads from useSetlistStore.

---

## SA3 git log (recent first)

```
e10c8af phase B: global MIDI listener — keyboard plays piano-roll voices
ff8724e phase A: globalize bottom dock — multi-tab panel + log side-by-side
41f9c52 fix(log): log is GLOBAL — full-width bottom footer, not inside library
3f87406 fix(branding+library): favicon scales right, single library toggle
```

## VJ git log (local — `main` is ahead of `origin/main` and they've
diverged)

```
620c2b3 phase C: SA3 input mutes + forwarded MIDI  ← LOCAL ONLY, conflicts with origin
861ab7e feat(layout): collapsible controls + canvas fullscreen toggle  ← last pushed
a7996a0 feat(midi): live MIDI input — automap + manual MIDI LEARN
ea49268 feat(layout+playlist): responsive flex on narrow viewports, audio playlist
f0ca6e8 feat(media): accept audio + image files in addition to video
```

## Uncommitted on SA3 side (Phase C in flight)

```
frontend/src/views/VJView.tsx        ← chips → buttons + postMessage forwards
```
Plus the typecheck passed (`npm --prefix frontend run lint` exits 0).

## How to resume

1. **Reconcile VJ project divergence** (user decision). The cleanest
   path is probably to `git reset --hard origin/main` on the VJ
   project, then re-add the bridge plumbing on top of the new
   structure. The bridge logic itself is:
   - `sa3Bridge.ts`: add `subscribeToInputs`, `subscribeToMidi`,
     `getExternalInputs`. Handle `sa3-vj/inputs` and `sa3-vj/midi`
     messages.
   - `useAudioAnalyzer.ts`: skip external levels when
     `getExternalInputs().audio === false`; return zeros for the mic
     path when `mic === false`.
   - Existing MIDI mapper (whatever the new structure calls it):
     subscribe to forwarded MIDI events alongside direct Web MIDI.
2. **Commit + push Phase C SA3 side** once VJ reconciliation is sorted
   (or independently — the SA3 commit is functionally complete on its
   own; the VJ side just no-ops on the new messages until the bridge
   is wired).
3. **Resume Phase D** — Library redesign. Largest pure-frontend phase;
   no cross-project dependencies.
4. **Phase E** — MIX cleanup + EDIT polish.
5. **Phase F** — DJ tab + VJ SET integration.

## Layout invariants memory (locked, do not violate)

- No left panel ever.
- Tabs: MAKE / EDIT / MIX / TRAIN / LEARN / VJ in that order.
- Log is GLOBAL — full-width footer, INDEPENDENT of library panel.
- Bottom multi-tab panel is GLOBAL across every tab.
- Library has ONE collapse handle (CenterTabBar's right arrow).
- Never write "Co-Authored-By" trailers on commits.
- Never downgrade external model catalogs without explicit OK.
- Ruff is pinned to one exact version in both pyproject.toml and
  lint.yml; both update together in the same commit.
