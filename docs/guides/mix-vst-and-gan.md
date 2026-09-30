# Hosting VST3 plugins and .gan web plugins in MIX, and VST3 instruments in EDIT

The MIX tab processes a source audio file through an ordered effect chain. The
chain accepts three kinds of node: built-in FFmpeg effects served by the
backend, VST3 plugins hosted through pedalboard, and Ares-style rack effects
that bake client-side. A separate class of `.gan` web plugin renders in the
effect stage for control and display. This guide covers where VST and GAN sit in
the rail, how theDAW scans and hosts VST3 plugins, how a VST3 node joins the
chain and opens its native editor, how a `.gan` plugin loads and renders, how
PROCESS CHAIN renders a chain that mixes these node kinds, and how a scanned
VST3 instrument plays an EDIT track's MIDI from the track header.

## The categorized effect rail

The effect rail is the left column of MIX. It lists categories, and the
selected category drives what the Library column shows. The rail defines these
entries in order:

- All: every effect in MIX, grouped by category.
- Studio: Studio modules, the Ares control surface, and the psychoacoustic
  effects.
- Magenta: Magenta RealTime 2 generative instruments (Collider, Jam, MRT2).
- VST: VST3 plugins hosted through pedalboard. Adding one places a `vst3` node
  in the chain.
- Plugins: `.gan` web plugins. Open a `.gan` file or import a VST Foundry
  export. The plugin renders in the effect stage.
- The FFmpeg categories from the effect catalog: Stacks, Dynamics, EQ, Tempo,
  Cleanup, Export.

Each rail button shows a count on the right. The VST count reflects the number
of scanned VST3 plugins. The Plugins count reflects the number of installed
`.gan` plugins. Selecting a category changes the Library heading and the
browser body below it.

Under the category list sits Quick Master, a set of four knobs (Punch, Air,
Drive, Ceil) that add or sync a mastering-chain entry in the chain.

## VST3 hosting through pedalboard

The `vst` backend module declares its manifest in
`backend/modules/vst/module.json`. It mounts under the `/api/vst` prefix and
describes itself as VST3 plugin hosting through pedalboard (Spotify) with scan,
load, chain, and process operations. The module has no sidebar entry; it is
reached from the MIX rail.

### Scanning

`GET /api/vst/scan` scans the standard VST3 directories and caches the result.
Passing `refresh=true` forces a live rescan and rewrites the cache. The Library
column exposes this as a rescan action on the VST category. `GET /api/vst/scan/{path}`
scans a custom directory and never caches. Each scanned plugin returns its
descriptor, including path, name, manufacturer, and category.

The scan files each plugin as an effect or an instrument from its VST3
category. The instrument slot in an EDIT track header lists only the plugins
filed as instruments.

The MIX VST browser lists each scanned plugin as a row or a tile. A plugin
already present in the chain is marked. VST tiles have no captured native
faceplate, so each renders a generated thumbnail seeded from the plugin name
and manufacturer.

### Loading and processing

Two processing paths exist. `POST /api/vst/load` loads a plugin into a
persistent instance registry and returns its parameter descriptors, and
`POST /api/vst/process` runs an ordered list of loaded instance IDs over a file
on disk. The MIX chain uses the stateless path instead: `POST /api/vst/process-file`
accepts an uploaded audio file, a plugin path, an optional parameter map, and an
optional captured `raw_state`, loads the plugin fresh, processes the audio, and
returns processed WAV bytes. The plugin is discarded after the call and never
enters the instance registry. This mirrors the FFmpeg `/api/studio/process`
call so a VST3 can act as one stage of the chain.

pedalboard expects float32 audio laid out as frames by channels. The backend
reads the uploaded audio with soundfile in that layout, runs the chain, and
writes WAV back.

## Adding a VST3 node and opening its editor

Clicking a VST in the browser adds it to the chain once and opens its native
GUI in the same action. Re-clicking a plugin already in the chain reopens its
editor rather than adding a duplicate. The chain entry carries an `effect`
value of `vst3` plus a `vst` object holding the plugin path, plugin name, and
an optional captured `raw_state`.

The native editor runs in a sidecar process because pedalboard's `show_editor()`
blocks its thread and must run on a process main thread.
`POST /api/vst/open-editor` launches the sidecar. On Electron with a parent
window handle and rect, the editor reparents into that window and clips to the
host box; without a parent handle it opens as a floating window. When the editor
window closes, the sidecar writes the plugin's full state to a per-plugin JSON
file. The frontend polls `GET /api/vst/editor-result` and stores the returned
`raw_state` on the chain node, so the dialed-in sound is reused at process time.

`VstEmbedHost` is the host box in the MIX effect stage. It reports its geometry
and scroll offset to `POST /api/vst/editor-rect` as the box moves, resizes, or
scrolls, and the sidecar watcher repositions the native window to match. The
box polls `GET /api/vst/editor-size` for the plugin's natural window size and
sizes an inner spacer to it, so an oversized editor keeps its true size and is
reached by scrolling. Expand grows the box to a large overlay. Close sends a
close request through the rect endpoint. The editor is never closed on React
unmount, so panel re-renders and StrictMode do not close it.

## Loading and rendering a .gan web plugin

The `plugin` backend module declares its manifest in
`backend/modules/plugin/module.json`. It mounts under `/api/plugin` and imports
and runs `.gan` web plugins (pseudo-VSTs). It imports VST Foundry exports,
serves the plugin UI to an iframe, and relays the plugin's control output to
theDAW targets. Like the VST module it has no sidebar entry.

A `.gan` file is a portable bundle. On open, the backend extracts the bundle to
a runtime directory and returns the manifest plus an entry URL of the form
`/api/plugin/<id>/runtime/<entry>`. The frontend client in
`frontend/src/lib/ganClient.ts` exposes the operations: `list` returns installed
plugins from `data/plugins`, `open` installs and opens a `.gan` at an arbitrary
path, `openById` opens an already-installed plugin, and `importOwl` imports a
VST Foundry export (a `project.json` or its folder) into a `.gan`. Two bundled
surfaces have dedicated build calls: `packageOwl` builds The Owl sidecar plugin
and `packageAres` builds the Ares control surface.

`GanPluginStage` renders the open plugin in the effect stage footprint, the same
spot Studio modules land. It iframes the entry URL served from the backend
runtime. The runtime letterboxes its canvas to preserve aspect ratio, so an
oversized plugin shrinks to fit rather than overflowing. Expand pops the iframe
to a near-fullscreen overlay while keeping the same iframe source, so the
plugin's control state and wiring persist across the toggle. The plugin's
control postMessages bubble to the app for a host to route. With no plugin open,
the stage shows a prompt to open a `.gan`.

Opening or importing a `.gan` from the Plugins browser sets it as the active
plugin and hands the effect stage to it. Ares sits under the Studio category.
Picking it ensures one `ares` composite effect is in the chain, focuses that
entry, and opens the Ares `.gan` surface in the stage.

## PROCESS CHAIN over mixed node kinds

PROCESS CHAIN runs the enabled entries in visible order over the source file.
The run guards against an empty source or an empty chain and reports a MIX
status message.

Rack effects (the psychoacoustic and Ares entries) bake client-side through
Web Audio and are unknown to the backend. The chain is walked in visible order
and split into consecutive segments of two kinds: runs of backend or VST
effects rendered over HTTP, and runs of rack effects baked offline. Each
segment's output feeds the next, so an interleaved arrangement bakes in the
exact order the chain shows.

Within a backend-or-VST segment, each entry processes in turn. A `vst` entry
calls the VST path with its plugin path, plugin name, parameter map, and
captured `raw_state`. Any other entry calls the FFmpeg `/api/studio/process`
path with its effect id and parameters. Each stage runs with the library save
skipped, so only the final result is saved. Its output blob becomes the input
file for the next stage. A rack segment bakes its run offline; a bake failure
returns the input unchanged so the pipeline still completes.

After the last segment, the final blob becomes the MIX output, plays back, and
is imported into the Library tagged as an effects chain. The chain label joins
every enabled stage name, using the plugin name for VST nodes and the effect
label otherwise.

`.gan` web plugins are not audio stages in PROCESS CHAIN. They render in the
effect stage for control and display. PROCESS CHAIN relays their control output
to theDAW targets and does not mix them into the offline render.

## VST3 instruments in EDIT track headers

A MIDI track in EDIT can play its MIDI clips through one of the scanned VST3
instruments in place of EDIT's soundfont synths. The instrument slot sits in
the track header under the track's instrument select. It shows on a track that
holds a MIDI clip or already has an instrument program (a track template sets
one), and it is hidden while the track is frozen. While the slot is on, the
status word after the instrument select reads Live, and its hover text says
the track plays live through its VST3 instrument.

### The instrument slot

An empty slot shows a VST key and the words No VST instrument. The VST key
opens the list of scanned instruments under the heading Instruments, with the
count beside it. Each row names a plugin with its vendor beside it. The key
beside the heading (Rescan VST3 folders) scans the plugin folders again. With
no instrument found, the list reads "No VST3 instruments found. Set your plugin
folders in Settings, then rescan." Picking a row puts that plugin in the slot,
switched on, and the LOG says the track plays its MIDI through it.

A filled slot shows the plugin's name, a status dot with one word, an on/off
key and a key that empties the slot. The VST key stays in front of the name
and opens the list again. Picking any row there, the plugin already in the slot
included, puts a fresh copy in the slot with that plugin's default settings,
and the settings captured before are gone.

Clicking the name opens the plugin's own window. On a machine with the live
VST host, the window belongs to the live instance of the plugin, which starts
if it is not running yet. Where the live host is missing or does not start, a
separate copy opens through the editor sidecar described above, and the status
bar says "Live plugin host unavailable - editing a separate copy; changes apply
when you close the window." The settings dialed in the window are captured
into the slot: every 5 seconds while a live window is open, and when the
window closes.

The on/off key switches the instrument off and on and keeps the plugin and its
state. Switched off, the track plays on EDIT's synths again and the plugin's
name is struck through. The empty key (hover text: Empty the instrument slot)
removes the plugin and its captured state, and the track plays on EDIT's synths
again.

The status word says how the instrument sounds live:

- Print: the plugin is not playing live. Switched off, the track plays on
  EDIT's synths. Switched on, the plugin has no live host running yet (playback
  starts one), or this machine has no live VST host, and the hover text then
  gives the reason. Bounces, freezes and exports still print through the
  plugin.
- Opening: the live host for the instrument is starting.
- Live: the plugin plays the track live, and bounces, freezes and exports print
  through it.
- Error: the live host failed. The hover text gives the reason when there is
  one.
- Update: the installed live VST host was built before it could take notes, so
  the part is silent live until theDAW is updated. Bounces, freezes and exports
  still print through the plugin.

While the slot is on and the word is anything but Live, the track's MIDI clips
make no sound in live playback. EDIT's synths do not stand in for the plugin.

A track with a filled slot shows the freeze key in its header. Freezing prints
the instrument into the track's stem and empties the slot while the track is
frozen. Unfreezing puts the instrument back with its state.

### Articulations

A filled slot shows an Articulations select under it. It sets how the plugin is
told each note's articulation, as the piano roll's articulation lane marks it.

- Keyswitch notes from C0: a keyswitch note on theDAW's default layout.
  Ordinario is C0 (MIDI note 12), and each articulation is one semitone above
  the one before it, in the order of the table below.
- UACC on CC 32: Spitfire's UACC values on controller 32 for ordinario, tremolo,
  marcato and pizzicato. Every other articulation still switches by its
  keyswitch note.

| Articulation | Keyswitch note | UACC value on CC 32 |
|---|---|---|
| Ordinario (a note with none) | C0 (12) | 1 |
| Legato | C#0 (13) | keyswitch |
| Staccato | D0 (14) | keyswitch |
| Spiccato | D#0 (15) | keyswitch |
| Marcato | E0 (16) | 52 |
| Pizzicato | F0 (17) | 56 |
| Tremolo | F#0 (18) | 11 |
| Col legno | G0 (19) | keyswitch |
| Harmonics | G#0 (20) | keyswitch |
| Con sordino | A0 (21) | keyswitch |

A switch goes out where a note's articulation differs from the note before it,
one tick (1/960 of a beat) ahead of the note, on every channel the track's
notes play on. A keyswitch is a note-on at velocity 1 and its note-off. Once any
note of the track carries an articulation, the first note of each clip sends
its switch as well in live playback, and the first note of a print does the
same, so the part starts on its own articulation whatever the plugin was left
on. Where playback starts in the middle of a passage, the switch in force there
is sent first.

On a VST3 track every note stays on its lane's channel. No articulation takes a
General MIDI preset or a channel of its own there. Each note still plays shaped
by its articulation: staccato at half its written length, spiccato at a third,
marcato louder and a little detached, col legno short and soft, harmonics and
con sordino softer, legato a little longer so it joins the next note. The
written notes stay as written.

The select is saved per track. A track that never set it uses Keyswitch notes
from C0.

### Live playback through the native host

Live, the instrument is hosted by the native live VST host the way a live
`vst3` insert is, one host process per slot. EDIT sends it the track's MIDI:
notes, every controller the part writes, each bent lane's bend range and wheel,
and channel pressure for notes that carry their own expression. A track that
rotates expressive notes across member channels (the Expression setting in the
track's MIDI out panel) sends each such note on a member channel with its
pressure, CC 74 and bend. So the plugin can receive notes on more than one MIDI
channel when the part has bent lanes or expressive notes. Program changes and
bank selects are not sent, since the plugin plays the preset dialed into it.

Each message is sent ahead of time and stamped with its place on the timeline,
earlier by the slot's live latency, so the instrument sounds on the beat with
the track's other audio. Stop, a seek and a loop wrap release every note the
plugin still holds.

The instrument sits ahead of the track's inserts. Its audio passes each clip's
gain and fades, then the track's fader, insert rack and pan. Audio clips on the
same track play beside the instrument and never through it. While the slot is
on, EDIT's synths leave the track's MIDI clips alone.

### Printing on bounce, freeze and export

Every bounce, freeze and export prints each instrument track in its scope
through `POST /api/vst/render-midi` before the mix renders. The print plays the
messages the live feed sends, articulation switches included, from the start of
the track's first clip in scope to its last message plus 4 seconds of release.
It renders at 44.1 kHz stereo, one track per request, through a fresh copy of
the plugin loaded with the slot's captured state. A state the live host
captured prints through theDAW's own host, and any other state prints through
pedalboard.

The print replaces the track's MIDI clips in the bounce with one audio clip,
shaped by each clip's gain and fades, and that clip runs through the track's
fader, insert rack and pan. Muted clips are left out, and a selection prints only
the selected clips. The LOG counts the prints ("Printing VST instruments for the
bounce") and lists any state or parameter the plugin did not take ("VST
instrument on" and the track name). A print that fails stops the bounce with a
message naming the track, so an export never holds silence where the part
should sound. The route's size and length limits are in the sound banks and
MIDI out guide.

### Saving the slot in a project

A `.tasmo` project keeps the slot on the track as its `instrument` entry: a
`vst3` chain entry with the plugin path, the plugin name, whether the slot is
on, the captured `raw_state` and the `state_host` that captured it. It writes
`articulation_switch` (`keyswitch` or `uacc`) where the track sets one. On open,
a slot that names no plugin is dropped, and an `articulation_switch` value the
app does not know reads as keyswitch. A project saved before the slot existed
opens with its tracks on the soundfont synths.

### External-only tracks

A track set to External only in its instrument select plays through its MIDI
out port alone, and its instrument slot plays nothing, live or in a print. Its
articulated notes play shaped on its own channel. No keyswitch, no UACC value
and no General MIDI preset change goes to the port. A bounce, freeze or export
leaves the track's MIDI clips out, and the arrangement's MIDI export still
writes their notes.

### The slot and the assistant

The in-app assistant's `editor_set_track_instrument` action puts a scanned VST3
instrument, named by its name or path, in a track's slot, switches the slot on
or off, or empties it. The Articulations select is set in the track header.

## Platform and format support

The `vst` manifest declares hosting through pedalboard (Spotify) and the VST3
format. The stateless process endpoint reads and writes audio with soundfile
and returns WAV. The native-editor embedding path targets Electron on Windows,
where the sidecar reparents the plugin window into the host BrowserWindow by its
window handle; without a parent handle the editor opens as a floating window on
any platform pedalboard supports.

Live playback of an EDIT instrument slot uses the native live VST host
(`thedaw-vst-host`), a Windows program built from `native/vst-host`. The print
on bounce, freeze and export uses pedalboard, or the native host when the
native host captured the slot's state.

The `plugin` manifest declares `.gan` web plugins (pseudo-VSTs) and import of
VST Foundry exports. The plugin UI is served to an iframe from the backend
runtime, so a `.gan` runs wherever the backend and a browser context are
available.
