# Changelog

Shipped and verified work. An item lands here when it leaves
[IN-THE-WORKS.md](IN-THE-WORKS.md) — the user called it done, or it was verified
by build, test, or observed behaviour.

Newest first.

## 2026-09-06

### Release

- **v0.1.5** — LOOM Phase 0, the Magenta GPU lane, stems resilience, the
  duotone themes and everything below. The release workflow now passes
  `SWAY_REPO_TOKEN` to the installer builds and fails fast when the secret is
  missing; that missing pass-through is why the v0.1.4 tag never produced
  installers. Pinokio launcher updated in lockstep.

### Queue re-check

- **IN-THE-WORKS re-verified against `main`.** All 75 open items were checked
  against the code; 22 were found done and merged and are retired here.
  - P0: the footer action button is keyed on the real tab (`activeView`
    cluster); `navigate('train')` can no longer brick CREATE; the assistant
    approval stack is live (T2 tools park as `pendingAction` and render the
    confirmation card).
  - Feedback: MAKE's empty-prompt error is rendered; the Magenta setup gate was
    rebuilt and dict `detail` payloads are unwrapped; Underfit's 503 diagnosis
    is rendered; a failed Settings PATCH rolls back and shows a notice.
  - Dead controls: "Send to DJ" automix handoff is consumed; assistant
    navigation reaches all 12 workspaces; Media bucket "Send to INIT" lands on
    MAKE.
  - Wrong output: NodeF.I. Effect node no longer 400s on first run; NodeF.I.
    wires are deletable; Underfit's dashboard URL derives from the live port.
  - Ableton: `performRouting` hydrates on both project-load paths, CcMods
    included.
  - P2 / frontier: OPFS autosave and crash recovery; stems-on-a-clip explode to
    tracks; the 12-tool `editor_*` assistant vocabulary with a real arrangement
    context.
  - Second session: NodeF.I. cursor offset; NodeF.I. node-editor toolset;
    lower-panel toggles (superseded by the footer action button); `.swayproj`
    import; Sway deck factory CC/note map.
- **Retired as stale:** "the staged SwayCommand build ignores `sway/visibility`"
  — the bundle handles it and SwayView pushes it.
- **Theme picker previews without a scrim** — the overlay no longer darkens
  the editor while a theme is chosen, so colours can be judged live. Last
  Tailwind v3 form in the tree (`z-[300]`) removed.
- **Twelve duotone themes** added to the picker (Navy & Gold, Charcoal & Amber,
  Forest & Cream, Burgundy & Rose, Slate & Copper, Ink & Cyan, Plum & Mint,
  Cocoa & Sand, Olive & Bone, Cream & Navy, Blush & Charcoal, Sage &
  Terracotta).

### Evening: Magenta GPU lane, stems resilience, LOOM samples (verified by build + tests; live check pending)

- **Magenta engine start waits its turn for the GPU.** Both bring-up paths take
  the pipeline's single GPU lane, so a Demucs / whisper / MIDI run can no longer
  sit on the card while JAX loads (the `RESOURCE_EXHAUSTED` failure from the
  full-suite pass). Status reports "waiting for the GPU" while queued; an error
  state carries a classified `error_kind` and a one-sentence `fix` that the
  Restart card shows.
- **Stems polling survives a dropped sidecar connection** (six retries with
  reconnect) and any remaining failure is a 503 with a cause, not an ASGI
  traceback.
- **LOOM**: uniform Jacquard-style square tiles with a step ruler and per-tile
  glyphs; rebuilt on theme tokens after the contrast audit found 58 light-theme
  text failures on the first cut; four sample scores (two simple, two involved)
  in the CODE pane; quoted values in query literals.

## 2026-09-05

### SING, SCORE, pipeline, docs

- **SING tab** — large centred lyrics, glide scroll, mismatch underlines, AUTO
  align; whisper alignment on the GPU, stems-first vocals, language picker.
- **SCORE** — NOW/INK look prefs, TRAIL hold/flash for the ink, centred strips,
  one layout per zoom, kept-alive views, smooth forward-only strip scroll.
- **Pipeline** — one coordinator for stems, MIDI and lyrics; forced-aligned
  lyrics; GPU everywhere.
- **Docs** — README how-to per tab; SING guide; play-along look settings;
  prepared DJ sets; pipeline scheduling.

## 2026-09-04

### Chimera v2, SCORE play-along, release

- **Chimera v2** — phrase engine, seam healing, and a CREATE that never stalls
  silently.
- **SCORE** — play-along modes, percussion notation, drum transcription, chord
  track, Beat Saber export.
- **Attention** — flash attention gated on GPU compute capability (Turing GPUs
  fall back cleanly).
- **Shell** — width- and height-aware scale; Tour view rewrite; control polish.
- **Library** — lyrics groundwork for SING.
- **Release** — v0.1.4; six stale test assertions caught up.

## 2026-09-03

- **Telemetry** — every GPU reported, not just `cuda:0`, with device-wide VRAM.

## 2026-09-02

### Settings, Levels, effects, onboarding

- **Settings** — one screen; six-state Magenta engine gate; real model list;
  Lyria install; one-click Magenta install; HF token field; real error text for
  gated models.
- **LEVELS** — a conventional meter bridge (dBFS ladder, LUFS tiles against
  target presets, true peak, correlation, balance, 60 s history) replacing the
  six icon-switched views.
- **Effects** — a real control panel for every effect, rack entry and tool;
  BACKLOG FX-001 closed. MIX viz rack collapsible, ARES controls on their art at
  first paint, one-shot `.gan` reveal; viz-row icon buttons labelled with
  pressed state.
- **Onboarding** — Chimera DNA splice fixed, tour rebuilt, one-screen HOME,
  guided TOUR.
- **Underfit** — dashboard no longer crashes on an empty seq-info table;
  diagnosis payloads without an issues array tolerated.
- **Showcase capture** — attach mode drives an already-open window and
  screen-records it; the film's cast comes from `showcase/_cast.json`.

## 2026-08-31

### DJ prepared sets, merges

- **DJ prepared performance sets** — automated timeline automix plus assistant
  control (PR #140); review fixes for automix and performance-set path handling.
- **Merged to main** — NodeF.I. rename and premium pass; slim bottom chrome;
  Underfit venv self-repair (a half-built venv is detected and repaired);
  inpaint model selection; POSIX dev stack; errors that were being discarded
  are now surfaced.
- **Sway** — a request body can no longer widen the media allowlist.

## 2026-08-28

### NodeF.I. tendrils, PERFORM rail (verified live)

- **NodeF.I. tendril controls** replace the SLIDE sliders — filament-under-
  tension ranged params, asymmetric cells for short selects; drag, wheel, keys,
  double-click reset, click-to-type. Type ramp raised everywhere.
- **PERFORM right rail** — ROUTES (filterable, grouped) and PARAMS (per-track
  device browser pushing tendril edits into the running chains). Default
  closed, drag-resizable, zero footprint when closed.

## 2026-08-27 (later passes)

### Issue triage #127 #131 #132 #133 #134

- Inpaint sends the selected model; MAKE inpaint refuses an empty region with a
  "drag a region" message; the model picker persists; HF sign-in card raised
  from gated download failures; Underfit venv probe, Repair vs Create, `log_tail`
  rendered, 503 detail rendered, port from `diag.port`; installer ships
  `underfit/`; Underfit model registry JSONs vendored; Linux launcher
  `theDAW.sh` + guide; flash-attention visibility in `/api/health`; five docs
  that were wrong corrected.

### Sway Perform, Kargyraa, NodeF.I. passes

- **PERFORM pads punch FX** (note-driven CcMods, momentary or `latch`); chain
  param pushes keep sibling params; new `kargyraa` subharmonic rack effect;
  `.tasmo` VST nodes stay inert in PERFORM; per-song templates regenerated.
- **Open-in-all-surfaces** — a project opens in EDIT and PERFORM from one load;
  grid-only projects land on PERFORM. Bottom chrome slimmed ~30 px.
- **NodeF.I. (then Audimate)** — premium pass (glass dock, goo rail, pull-a-
  node-out-of-the-goo), template patches, LIVE performance engine (Stem, Filter,
  VCA, Echo, Crossfade, LFO, Live Out, mod wires), Rack FX live node, one live
  set per song, square node rail, resizable rails, saved sets with export/
  import, Suno cloud node, inspector redesign, rename to NodeF.I.
- **Every-theme contrast** — translucent hex chrome surfaces remapped for light
  themes; hover and pale-accent text darkened. Verified on Porcelain.
- **De-icon / de-glow sweep** — icons only where they are the control;
  decorative LED dots removed. Footer owns the action button; per-frame tick
  isolated so the footer shell stops re-rendering at 60 Hz.
- **docs/guides/audimate.md** rewritten.

## 2026-08-26 (third session)

### The P0 cluster and the big builds (coded that day, merged 2026-08-31 → 09-04)

- `activeView` cluster, approval stack, agentic editor vocabulary, Media bucket
  "Send to INIT", OPFS autosave, NodeF.I. node-editor tools, footer-styled
  lower-panel toggles, `.swayproj` import, stems-on-a-clip explode, XR BUS
  tester moved to a dev-only dock tab, EDIT FX/ARES panels portaled and plugin
  windows detachable, unified effect control windows, SWAY tab track add/save/
  playback made real, Sway performance template + the `perform_routing.ccMods`
  persistence it exposed, note-by-note notation follow, EDIT toolbar
  decluttered.

## 2026-08-27

### Per-song Sway performance templates

- **Three per-song Perform sets authored and round-trip verified** —
  `Sway Perform - {Prologue,EACC,Just Give Up}.tasmo` in
  `Documents/theDAW Projects`, from the new `scripts/make_sway_song_templates.py`.
  Each: 6 stem columns, 26 looping clips, 29 devices, 8 scene pads, 29 pad-punch
  routes, 47 knob/XY routes, real analyzed tempo and key baked in. Verified by
  loading each file back through `TasmoFile.load` — clip count, route count,
  `latch` flags and VST state all survive. ("Prelude" resolved to the album's
  `01 - Prologue.wav`.)
- **Stems sidecar was dead on this machine and is fixed.** Its venv's
  `pyvenv.cfg` pointed at a base Python under a stale user profile, so every
  separation failed with a dependency-install error naming packages that were
  actually present. Re-pointed at the installed Python of the same minor
  version; 6-stem separations for Prologue and Just Give Up then completed
  through `POST /api/stems/{id}/run`, with every stem verified to match its
  master's duration and sample rate.

### Documentation sweep

- **New guide: [guides/sway-perform-live.md](guides/sway-perform-live.md)** and
  registered in the RAG index — the Perform grid, the SwayCommand deck and its
  factory CC/note map, scenes vs FX punches, the four routing layers that travel
  in a `.tasmo`, the shipped templates, and the Kargyraa Sub engine.
- **Corrected documentation that was actively wrong.** `USER_GUIDE` §16.10 still
  described SWAY as a camera-pose bottom-panel tab (it is the embedded
  SwayCommand cockpit); §35.3 described a generic routing panel (it is the
  SwayCommand deck); §7.7 advertised "six psychoacoustic processors" and a
  MASTER FX / `F` button pair that no longer exist (19 effects, one `FX` button,
  floating per-entry windows); §5 claimed nine center tabs; §16 claimed ten
  bottom tabs. The effects reference heading said 18 effects.
- **Documented shipped-but-invisible features** across the reference tree and
  guides: unified effect control windows, OPFS autosave and crash recovery,
  clip → stems explode, the 12 `editor_*` assistant tools and the T1/T2 approval
  tiers, all-workspace navigation, the NodeF.I. (formerly Audimate) node-editor toolset, note-by-note
  notation follow and the tab-timing migration, `.swayproj` import, the
  `/api/sway` route family, `POST /api/dawimport/sway`, and the `EffectChainNode`
  / `perform_routing` schema detail in the project guide.

## 2026-08-26

### Sway / Perform (second session)

- **A plugged-in Sway is seen by theDAW.** Master MIDI gate now defaults ON
  (persisted-store v2 migrate flips existing installs); theDAW holds the only
  `requestMIDIAccess()` and relays to the SwayCommand cockpit, so the old OFF
  default made hardware invisible here while standalone worked. Verified: relay
  traffic in the cockpit, playable.
- **SwayCommand embed splash tells the truth about MIDI.** Its `available`
  getter ignored relay mode and reported "WebMIDI unavailable" while relayed
  CCs played. Fixed in the staged bundle, re-applied on every
  `fetch:sway` (BUNDLE_PATCHES), and upstream in the SwayCommand source.
- **PERFORM auto-routes projects built for the Sway.** `.als` MIDI-learn
  mappings become direct CC→mix routes on load; dim-named mappings seed
  bindings; SwayCommand's factory CC map ships as overridable defaults
  (learned > project > factory). Verified against the DNB template (110
  mappings parsed, routes live, deck animating).
- **The SwayCommand deck is PERFORM's assignment surface** — verbatim port of
  `surface.js`, collapsible; pads→scenes (chromatic notes), knobs/XY/gestures→
  volume/mute/any live FX-chain param (`handle.updateParams`), buttons→
  transport by learn. SWAY tab reduced to the cockpit alone.
- **Perform header: icons only.** One Open (imports on pick/Enter/recent), one
  Save (.tasmo); detected-DAW, warnings and missing-samples are hover badges;
  the InfiNight credit is an info icon; footer strip removed.

### Boot, orb, capture (second session)

- **Boot cinematic**: full-window goo sheet + wordmark in the orb's exact
  wet-obsidian material (mirror stays a mirror — visibility comes from
  forward-hemisphere light angles and the bright room env on the sheet); the
  wordmark sinks into and rises out of the sheet; credits gated on formation
  (theDAW → by → GANTASMO). Verified by screenshot at three boot phases.
- **Orb**: 112px (−30%), all rings/halos gone, ferrofluid from the first
  visible frame (mounts post-boot), sticky bottom-left corner surviving
  resizes until first drag, ~2.4× slower idle cycles, footer tip bubble
  (operational tips, greeting dwell, never truncates, fixed width so the
  now-playing block stops jumping) replacing G-Search; Ctrl-K opens the
  library rail.
- **Capture harness**: video/wall-ratio slicing (fixes the one-scene-early
  drift on long takes), stamped per-run session files (a fixed name destroyed
  a finished take once), bounded + concurrent stem loading (285s→17s to first
  hold), `data-boot-splash` wait, monitor pinning + CDP fullscreen, six new
  tab scenes, driven TOUR map/routing. 67 clips reshot at 1920×1080.


### Ableton `.als` import

- **Imported projects can actually play.** No importer registered its project's
  media with `media_access`, so every clip fetch returned 403 and the Perform
  grid rendered correctly and played silence. Because media roots persist to
  disk, the same set was silent on a clean install and worked afterwards if any
  earlier save had touched that folder — the source of the "it's inconsistent"
  report. All nine importers now register the source folder and every clip path.
- **Saving from Perform no longer destroys the project file.** It wrote zero
  clips: `tasmoToSession` stamps a scene index on every clip and the save path
  filtered exactly those out (and `0 == null` is false, so even row 0 went).
- **`.tasmo` can represent a clip-launch grid.** Added scene/slot/track placement
  to `Clip` and a `scenes` list to `TasmoProject`; an 8×6 grid used to reload as
  an 8×1 "Scene 1" ladder. Legacy files still validate. The session-clip filter
  moved from save to load.
- **Session clips honour their trim, loop, and warp.** Length is now
  `CurrentEnd - CurrentStart` with the trim carried as an offset; `<Loop><LoopOn>`
  is read; `<IsWarped>` plus warp markers give the sample's own tempo so loops
  recorded at different BPMs stay together.
- **Live's colour palette is decoded** — the parser emitted the literal string
  `"index:26"`, which the grid ignored and the editor accepted as valid CSS.
- **Dead tempo XPath fixed.** The primary lookup missed in every real Live Set
  and time signature had no Live-12 `<MainTrack>` coverage, so a 6/8 project
  silently parsed as 4/4.
- **Frozen tracks no longer bleed into the arrangement** — an unscoped clip-slot
  walk reached `<FreezeSequencer>` and imported "FROZEN RENDER" as content.
- Solo parsing no longer depends on a falsy-Element footgun; MIDI velocity of
  exactly 1 is no longer inflated to 127; time signature, locators and source
  version now survive a save.

### Perform tab

- **Per-clip launch and per-track stop.** Every cell used to fire the whole row,
  so there was no way to hold a bassline while changing drums. Empty slots are
  stop buttons, as in Live.
- **Mute, solo and pan reach the audio graph** for the first time — there was no
  panner at all, and gain folded in only the Sway modulation mute. The S/M
  buttons now work and carry ARIA state.
- **Real launch quantization.** "1 Bar" was literal text while every launch fired
  immediately; the time signature was the literal "4 / 4".
- **Playback runs through the imported device chains** — the grid had zero device
  references, so an imported mix was completely dry. Metering moved post-FX.
- Missing samples are named instead of failing anonymously; an arrangement-only
  set explains itself instead of rendering a wall of dead cells; prefetch warms
  only launchable clips instead of decoding the whole project.

### EDIT tab

- **Clip add/delete no longer kills the transport.** `playEditorTimeline` closed
  over `clips.length`, so its identity changed on every edit and tore down the
  mixer mid-playback; `dispose()` never cleared `isPlaying`, leaving the footer
  stuck on Pause forever. The attach effect is now mount-only.
- **Trimmed clips survive a save.** `offset_into_source` was never persisted while
  the full untrimmed source was embedded, so a split vocal reloaded at the right
  position and length playing the wrong words.
- **Ctrl+D no longer corrupts the document** — duplicates reused the source clip's
  id, so two clips shared one id and every later update hit both.
- **Coordinate-space fix.** The shell applies CSS `zoom`, so pointer maths mixed
  viewport and local pixels: every seek, split point, loop edge, marker drop and
  drag read short, and clip drags picked the wrong lane.
- **Unsaved-changes guard**: a dirty flag, a `beforeunload` prompt and Ctrl+S.
- **Real pause** — Space and the transport button rewound to zero.
- **Per-clip gain**, applied identically live and in all three offline bounces,
  and persisted.
- **Editing additions**: clip clipboard, split at playhead, grid nudge,
  cross-track move, select-all, zoom-to-fit, follow-playhead, vertical zoom,
  a 13-division snap grid with triplets and dotted, BPM field and tap tempo,
  per-track VST3 inserts, and a `?` shortcut overlay.
- **LUFS meter reads the programme, not the monitor.** The listening fader was at
  the head of the graph, so turning the speakers down lowered the reading; it now
  sits last, with metering tapped post-FX and pre-monitor.
- **MIDI**: split clips no longer play the pattern twice; an instrument assigned
  after insert no longer plays one sound and exports another; live MIDI runs
  through the track's fader, pan, inserts and master rack instead of bypassing
  the mixer.
- Master VST freeze sends its captured plugin state instead of rendering at
  factory defaults; DAW-imported MIDI is no longer silent; empty-timeline clicks
  deselect; double-clicking a fader returns it to unity instead of silence;
  the delay's Mix control crossfades like every other wet/dry.
- `navigate('edit')` opens EDIT — it mapped to MIX, so the arrangement workspace
  was unreachable by name and the assistant could not open the tab it drives.

### SwayCommand

- **New SWAY tab** embedding the SwayCommand cockpit, served at `/sway-app` and
  shown in a same-origin iframe (cross-origin freezes its rAF transport clock
  when hidden).
- **Electron kept in lockstep**: main-process route, dev proxy, packaging
  resources, and `fetch:sway` wired into every dist chain — it was defined but
  never called, so a built installer would have shipped without the cockpit.
