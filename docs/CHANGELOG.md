# Changelog

Shipped and verified work. An item lands here when it leaves
[IN-THE-WORKS.md](IN-THE-WORKS.md) — the user called it done, or it was verified
by build, test, or observed behaviour.

Newest first.

## 2026-08-26

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
