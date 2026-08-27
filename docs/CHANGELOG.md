# Changelog

Shipped and verified work. An item lands here when it leaves
[IN-THE-WORKS.md](IN-THE-WORKS.md) — the user called it done, or it was verified
by build, test, or observed behaviour.

Newest first.

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
  tiers, all-workspace navigation, the Audimate node-editor toolset, note-by-note
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
