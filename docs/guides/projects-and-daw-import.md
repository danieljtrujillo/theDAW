# Projects and DAW Import

theDAW saves work as `.tasmo` project files and imports projects created in other DAWs. This guide covers the `.tasmo` format, how to save and open projects, which external DAW formats import, and where these actions live in the app.

## What a .tasmo file is

A `.tasmo` file is a single project container. On disk it is a ZIP archive with the comment `TASMOv1`. It holds three kinds of entry:

- `manifest.json` holds a plain-text summary that can be read without loading the whole project. It records the format string `tasmo`, the format version, the app version that wrote it, the project name, creation and modification timestamps, the audio mode (`embedded` or `linked`), the track and clip counts, and the sample rate.
- `project.msgpack` holds the full project state, serialized with MsgPack. This binary payload carries every track, clip, effect chain, automation lane, locator, and the generation history. Loading validates it against the `TasmoProject` model.
- `audio/` holds optional embedded audio. It is present only when the project is saved in embedded mode. Each clip's audio bytes are stored once under `audio/<name>`, and the clip inside `project.msgpack` points at that in-archive path.

An optional `vst_presets/` folder holds plugin preset blobs when a save supplies them.

### Embedded vs linked audio

A `.tasmo` records audio in one of two modes, shown in the manifest as `audio_mode`.

- **Linked**. Clips reference audio by absolute path on the machine that saved the project. The `.tasmo` stays small. The referenced files must exist for playback to work, so linked projects do not move cleanly between machines.
- **Embedded**. Each clip's audio is copied into the `audio/` folder inside the archive, and a SHA-256 checksum is recorded per clip. The project round-trips to another machine because the samples travel with it. On open, embedded audio is extracted to a `<name>_media` folder beside the `.tasmo` and each clip is relinked to the extracted file.

Files referenced by more than one clip are stored once. A `.tasmo` larger than 500 MB logs a soft warning that suggests linked mode.

### What the project payload carries

The `TasmoProject` model stores, per project: tempo, time signature, sample rate, author, locators, automation lanes, and generation history. Each track carries its name, type (`audio`, `midi`, `return`, `master`, or `bus`), color, volume, pan, mute, solo, arm state, order, input and output routing, send amounts, and a track-level effect chain. Each clip carries its type (`audio`, `midi`, or `generated`), timing, loop points, per-clip mute, the audio or MIDI file reference, MIDI notes, warp markers, a clip-level effect chain, and generation metadata (prompt, seed, and parameters) for generated clips.

Two fields preserve live performance setup across a save and load. `controller_mappings` stores the resolved Sway (MIDI-learn) auto-attach bindings. `perform_routing` stores the Perform-tab scene-launch and Sway-dimension modulation assignments.

## Saving a project as .tasmo

The **Save Project** action captures the live EDIT timeline and writes it to a `.tasmo`.

When the project on screen is the live edit, Save reads every clip on the EDIT timeline. Editor clips hold their audio in memory with no path to link, so Save uploads each clip's audio bytes alongside the project and writes them into the archive as embedded audio. If the EDIT timeline is empty, Save reports that there is nothing to save yet and takes no action.

When the project on screen came from a DAW import, Save writes that imported structure instead. The embed toggle then decides whether the on-disk sample files are copied into the archive (embedded) or referenced by path (linked).

Save prefills a destination path from the default projects folder and the project name, so a save can complete without browsing for a folder. The default folder is `Documents/theDAW Projects`, created on first save. The path is editable, and the chosen folder is remembered for later saves. The `.tasmo` extension is appended automatically when missing.

## Opening a project

The **Open Project** action loads a `.tasmo` and materializes it onto the EDIT timeline. Opening rebuilds the tracks and clips, extracts and relinks any embedded audio, and switches the center view to EDIT. Clips whose audio is missing or whose MIDI is empty are skipped, and the status bar reports how many tracks and clips came in and how many were skipped.

Both Open and Save keep a recent-projects list of up to twenty entries. The list survives restarts and is offered when picking a file.

Clips reference their audio by path. The browser cannot read those paths directly, so it streams each clip through the project audio endpoint. Browser-native formats (WAV, FLAC, MP3, OGG, M4A, AAC, Opus, WebM) are served as-is. DAW-native sample formats (AIFF, AIFC, CAF, WavPack, WMA) are transcoded to WAV on the fly and cached, so an imported project still plays.

## Importing an external DAW project

The **Import DAW Project** action reads a project file created in another DAW. Import first detects the format from the file extension, then either parses it directly or, for formats with no parser, returns an export-to-audio hint.

Detection reports a warnings list for every parsed project. Parsers never abort on a missing element. Anything uncertain is recorded as a human-readable warning and shown above the grid. It is not raised as an error.

### Formats with a direct parser

| DAW | Extension | What carries over |
|---|---|---|
| Ableton Live | `.als` | Arrangement-view tempo, tracks with mix parameters, audio clips with real timing, MIDI notes, locators, and VST/AU/native device references with best-effort parameter snapshots. Session-view clips are used only for tracks that have no arrangement content. |
| Reaper | `.RPP`, `.RPP-bak` | Track names and mix parameters, audio-clip timing in seconds, MIDI notes, and the full effect and device chain. A regex fallback reads track names only when the parsing library is absent. |
| Logic Pro X | `.logicx` | Tempo, time signature, and sample rate from the project metadata; recorded and imported audio as one track per file; per-track freeze audio; and the names of plugins that were used. The arrangement timeline lives in a proprietary binary blob, so imported audio starts at time zero and true region placement is not recovered. |
| FL Studio | `.flp` | Arrangement tracks with real timeline timing, MIDI notes from patterns, audio clips from Sampler channels, and mixer-insert effect chains. A flat channel-rack mapping is used when no arrangement is present. |
| Audacity | `.aup3` | Audio tracks. PCM samples are reassembled from the project database and exported to WAV per clip, then referenced by path. Effect names are best-effort. Audacity projects generally carry no MIDI. |
| Adobe Audition | `.sesx` | Tracks with names, volume, and pan, and audio clips referenced by relative or absolute path from the session XML. |
| Bitwig Studio | `.bwproject` | Tracks with content type, color, channel role, volume, pan, and mute, plus the device chain (VST3, VST2, CLAP, AU, and built-in devices) and arrangement lanes, read through the open DAWproject schema. |
| Resolume Arena | `.avc` | Tempo, layers as tracks, audio and video clips with source file paths and best-effort timing, and native or VST effects. MIDI is emitted only when a clip carries note data. |

### Formats with export guidance only

Cubase (`.cpr`) and Pro Tools (`.ptx`, `.pts`) use proprietary binary formats with no parser. Import detects them and returns a workflow hint: export the tracks to audio files from the source DAW, then import that folder. Logic Pro X also offers the same export-all-tracks hint for a full arrangement import when the packaged reader recovers too little.

An unrecognized extension is reported as an unsupported project type.

## Where these actions live

### App menu

The app menu (the hamburger button in the header) holds the project operations under a Project group:

- **Open Project**. Browse for a `.tasmo` and load it onto the EDIT timeline.
- **Save Project**. Write the live edit or the imported project to a `.tasmo`.
- **Import DAW Project**. Pick an external DAW project file to detect and import.

### Perform tab

The Perform tab imports a project and lays its clips out as a scene grid for live launching. Its header holds a project path field that accepts either a `.tasmo` or a DAW project file. A `.tasmo` opens directly into the grid. Any other DAW file goes through detect and import. The field opens the recent-projects list on focus for quick reopening.

Once a project is loaded, the Perform header exposes three controls:

- **Routing**. Toggle the panel that assigns the Sway or any controller to scene launch and mix modulation.
- **.tasmo**. Save the current Perform project as a `.tasmo`, capturing the active Perform routing so scene-launch and modulation assignments return on reopen.
- **Edit Timeline**. Load the imported project into the editable EDIT timeline.

Opening a `.tasmo` in the Perform tab restores its saved Perform routing, so scene-launch and Sway-dimension modulation assignments come back on open.
