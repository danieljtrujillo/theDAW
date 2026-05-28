# Codebase scan — what's hooked up, what's stubbed, what to improve

**Date:** 2026-05-28
**Branch:** `wip/pre-torchcodec-checkpoint`
**Companion:** `docs/in-flight-work.md`

User asked for a "quick scan of the codebase, see what's missing,
what could be hooked up, what could be improved, all that, and how
to resolve those issues." This is that scan. Items are flagged
**[Hooked]** (working), **[Stub]** (partial / placeholder), **[Gap]**
(missing or never built), **[Fix]** (works but flagged), and
**[Idea]** (potential improvement, not yet a problem).

The scan is intentionally a *honest snapshot* — I name things that
work as well as things that don't. The user can decide which of the
flagged items are worth touching next.

---

## 1. Backend modules

All 8 modules ship enabled by default and auto-discover from
`backend/modules/loader.py`. The loader skips disabled modules and
logs unhealthy ones without blocking app startup.

| Module | API prefix | Enabled | State |
|---|---|---|---|
| `analysis` | `/api/analysis` | ✓ | **[Hooked]** BPM / key / pitch via librosa. Right-click → Run analysis works. |
| `chimera` | `/api/chimera` | ✓ | **[Hooked]** Multi-source init audio mix. UI uses `addBlobsToChimera`. |
| `effects` | `/api/studio` | ✓ | **[Hooked]** StudioView is currently the surface. Moves into MIX tab once Pass 3 ships the content merge. |
| `library` | `/api/library` | ✓ | **[Hooked]** Pre-existing in-flight work — router + store. |
| `midi` | `/api/midi` | ✓ | **[Hooked]** basic-pitch engine. Right-click → Convert to MIDI works. |
| `settings` | `/api/settings` | ✓ | **[Hooked]** Feature toggles persisted to `data/settings.json`. |
| `stems` | `/api/stems` | ✓ | **[Hooked]** Demucs sidecar with isolated venv. Lazy-spawned. |
| `vj` | `/api/vj` | ✓ | **[Hooked]** Vite sidecar at port 5187 (NOT 3000), iframe + pop-out window, audio bridge via postMessage. |

**[Fix]** The `loader.py` JSON decode error path catches `Exception`
broadly without surfacing the manifest file path in the warning. A
broken `module.json` in any module silently knocks it out with no
diff between "missing manifest" and "malformed JSON". Two-line
change: log the path + traceback. Low priority.

**[Idea]** The sidecar pattern (stems' isolated venv + auto-spawn,
VJ's node dev-server auto-spawn) could be extracted into a tiny
`backend/sidecars/` helper if a third sidecar lands. Not yet.

---

## 2. Center-bar tabs (frontend)

Order locked: **MAKE | EDIT | MIX | TRAIN | LEARN | VJ**.

| Tab | View | State |
|---|---|---|
| MAKE | `AdvancedView` | **[Stub]** Still hosts only the AdvancedView contents. Plan step 3b merges `GenerateView` (CREATE) + `AdvancedGenPanel` (inpaint/init/chimera) in here as collapsible sections. Not yet done. |
| EDIT | `WaveformEditor` | **[Hooked]** Multi-track editor with inpaint, piano-roll roundtrip, send-to-init/chimera. Context menu migrated to the shared primitive. |
| MIX | `AdvancedEditorPanel` | **[Stub]** Hosts only AdvancedEditorPanel. Plan step 3b merges `StudioView` (Effects) + stems modal tools in here. Not yet done. |
| TRAIN | `TrainingView` | **[Stub]** Spartan visuals; user flagged "make TRAIN look not so dumb". No styling pass yet. |
| LEARN | `LineageView` | **[Hooked]** 3D + 2D + Genealogy, cluster halos, search overlay, node-details slide-out, right-click context menu (new this pass). Fullscreen toggle restored. |
| VJ | `VJView` | **[Hooked]** iframe + pop-out + audio bridge. MIDI bridge is `[Gap]`. |

---

## 3. Right-click coverage

All migrated to the shared `<ContextMenu>` primitive at
`frontend/src/components/ui/ContextMenu.tsx` (zoom-drift-fixed,
portal-mounted z-200). Per-surface status:

| Surface | State |
|---|---|
| Library entry rows | **[Hooked]** Send to Init/Chimera, Run analysis, Separate stems, Convert to MIDI, Download bundle, Show lineage. |
| Library SubTabList (stems + midi rows) | **[Hooked]** Append/send to editor, init, inpaint, chimera, download .wav / .mid. |
| Library top-level icon toolbar | **[Hooked]** SELECT / DOWNLOAD (submenu) / DELETE / FUSE / INPAINT / OPTIONS. |
| Waveform editor clips | **[Hooked]** Preview, split, duplicate, send to init/chimera, edit in piano roll, delete. |
| Graph nodes (LineageView 3D + 2D) | **[Hooked]** Inspect, center camera, copy ID, open in library, download bundle, open lineage rooted here. **NEW this pass.** |
| Waveform editor track headers | **[Gap]** Tracks have a header bar (name, mute/solo) — no right-click menu yet. Plan called for one. |
| Tag chips | **[Gap]** Library has tag chips on entries — no right-click for "delete tag", "rename tag", "show all tracks with this tag". |
| Bottom-panel tab buttons | **[Idea]** Not in plan; could add "Open in new pane" / "Detach" if popouts become a pattern. |
| Top-bar header buttons | **[Idea]** Same — not yet. |

---

## 4. Audio routing

The global player at `frontend/src/state/playerStore.ts` exposes:
- A single `AudioContext`, `master` GainNode, `analyser`, and one
  HTMLAudioElement.
- `getMasterGain()`, `getAnalyser()`, `getEngineCtx()` for other
  sources to plug in.

**[Hooked]** Everything that should route through the master gets it:
- HTMLAudioElement (current entry from library)
- Editor preview voices (registered via `editorPlaybackBridge`)
- Spectral visualizer reads from `getAnalyser()`
- VJ bridge reads from `getAnalyser()` (new this pass)

**[Fix]** A noted limitation in `playerStore.ts:42`: `_userGesture`
flag means the AudioContext stays suspended until the user clicks
*something*. This is the right behaviour but if a feature tries to
play audio programmatically before any user interaction, it'll
silently fail to start. Documented in the file's comment block.

---

## 5. Stems sidecar

**[Hooked]** Demucs + LARSNET via the integration-package at
`D:/StableAudio/JoshOG/integration-package`. Isolated `.sidecar_venv`
with torch+cu128. Cross-drive temp-zip move patched
(`shutil.move`). Live progress + abort.

**[Fix]** From `feedback_layout_invariants.md`: orphan sidecars
persist across main backend restarts (subprocess.Popen lifecycle on
Windows doesn't kill children when the parent exits). On restart,
the new backend tries to spawn a new sidecar but the old one is
still bound to the port. Mitigation: `start-dev.bat` kills the
ports first — but `POST /api/admin/restart` doesn't. Fix: have the
restart endpoint call `stems.sidecar.stop()` before scheduling
`os._exit(88)`.

**[Idea]** Same fix for VJ sidecar. Right now `start-dev.bat`
explicitly kills port 5187, but a backend-restart-via-button leaks
the VJ child.

---

## 6. VJ sidecar (just shipped)

**[Hooked]** Backend module + lazy spawn + iframe + pop-out window
+ audio bridge (SA3 master analyser → iframe via postMessage at
60fps).

**[Gap]** **MIDI bridge.** No central MIDI event dispatcher in SA3
to hook into — PianoRoll, StepSequencer, and any future MIDI-in
device each emit on their own paths. Need either:
(a) a central `useMidiBus` store that all MIDI sources publish to,
which VJView can subscribe to and forward, OR
(b) a thin emitter helper that any source can fire (
`emitMidi({kind, note, velocity})`).
Then VJView calls it via `iframe.contentWindow.postMessage({type:
'sa3-vj/midi', ...})`. VJ's `sa3Bridge.ts` listener accepts it. VJ
already has hooks where `audioReactive` triggers visuals — extend
to react to incoming MIDI events similarly.

**[Idea]** Audio-routing fidelity: the current bridge passes
amplitude buckets (bass/mid/high/volume) — same as VJ's own mic
analyzer. If the visualizer ever wants more fine-grained spectrum
(byte FFT, beat detection), expand the bridge payload.

**[Idea]** Two-way bridge: VJ could post messages BACK to SA3 (e.g.
"user toggled audioReactive off", "VJ wants to control SA3
playback"). Not needed yet, but the listener structure makes it
trivial later.

---

## 7. Settings + persistence

**[Hooked]**
- Module enabled/disabled persists via PATCH /api/modules/{name}/enabled
- Feature toggles in `data/settings.json` (auto-analysis,
  auto-stems, auto-midi, etc.)
- Right panel width + open state persisted to localStorage via
  zustand persist (`stabledaw-app-ui`)
- Lineage graph appearance persisted (`lineageGraphAppearance:v1`)
- Library entries + bundles + lineage all live on disk (server-side)

**[Gap]** Window position / pop-out VJ position not persisted. If
the user pops VJ out, moves it to monitor 2, then closes and
re-opens, it spawns at the default 1280x800 in the same spot every
time. Trivial localStorage add.

**[Gap]** Sidecar settings (stems count default, VJ project path
override) live only in env vars / settings.json. The Settings
modal's module rows only show enable/disable + description; no
per-module configuration UI. Could be a future expansion.

---

## 8. Tests

**[Hooked]**
- `tests/test_inference.py` — model loading / sampling smoke tests
  (parameterized over small/medium, medium skipped without CUDA)
- `tests/test_library_endpoints.py` — library router routes
- `tests/test_stems_engine.py` — stems engine (untracked, in user's
  floating work)
- `tests/conftest.py` — fixtures
- `tests/utils.py` — helpers

**[Gap]** No frontend tests. The plan explicitly opted out of UI
test infrastructure ("manual verification only"), so this isn't a
regression — but Playwright (in flight as part of the screenshot
task) could double as an integration-test harness if/when desired.

**[Gap]** No VJ-bridge tests. Easy to add a jsdom test that fires
postMessage events and asserts `getExternalLevels()` returns what
was sent.

---

## 9. Known floating work in `git status`

These predate today's commits and the user owns them:

| File | Notes |
|---|---|
| `backend/modules/library/router.py` | Format drift + content edits. |
| `backend/modules/stems/engine.py` | Format drift + content edits. |
| `tests/test_library_endpoints.py` | Format drift + new tests. |
| `tests/test_stems_engine.py` | New file (stems engine tests). |
| `frontend/src/components/audio/MicRecorder.tsx` | **[Landed in 885ee37]** as required dep of LibraryView. |
| `frontend/src/components/library/StemsRunModal.tsx` | **[Landed in 885ee37]**. |
| `frontend/src/lib/sendToTargets.ts` | **[Landed in 885ee37]**. |

The three frontend files were pulled in when I had to touch
LibraryView. Backend + tests are still floating.

---

## 10. Top quick wins (≤30 minutes each)

If the user wants small, high-leverage fixes:

1. **Orphan-sidecar fix on `/api/admin/restart`** — call
   `stems.sidecar.stop()` and (when present) `vj.sidecar.stop()`
   before `os._exit(88)`. Currently leaks subprocess children
   across restarts on Windows.
2. **Pop-out VJ window position persistence** — localStorage
   bookkeeping for `{x, y, w, h}`, restore on next pop-out.
3. **`loader.py` error reporting** — include the file path +
   stringified exception type in the "Module X failed to load"
   log line.
4. **Track-header right-click in WaveformEditor** — already has
   the action surface (mute/solo/rename); shared ContextMenu
   plumbing is identical to the clip menu.
5. **Tag-chip right-click** — "rename tag", "show all", "delete".
   Tiny ContextMenu wiring.
6. **`feedback_layout_invariants.md` rule for the "Library
   maintenance" section being gone** — already removed; this is
   just memory hygiene.

---

## 11. Larger items still on the plan

Documented elsewhere (`docs/in-flight-work.md`, plan file). Not
re-listed in detail here:

- CREATE content move into MAKE tab (preserve features)
- PROCESS content move into MIX tab (preserve features)
- VJ MIDI bridge (see §6)
- TRAIN view styling pass
- Reduce terminal-window proliferation on `start-dev.bat`
- Lyria integration as alternative gen backend (decision pending)

---

## 12. End-state summary

The app is functionally complete for the user's "everything we
already built" set: generation, editing, mixing, training, lineage,
library, stems, midi, analysis, chimera, VJ. The remaining work is
**rearrangement** (content moves into MAKE/MIX), **styling**
(TRAIN, button unification — already done), and **finish lines**
(VJ MIDI bridge, sidecar lifecycle hygiene).

No critical breakage is hidden anywhere I looked. The biggest
"latent surprise" is the orphan-sidecar issue on programmatic
restart — manifests as ports being held by dead children — and the
fix is small.
