# theDAW — Practical Plain-English User Guide

## What this guide is

theDAW is not one small tool. It is a complete music-production and performance environment that combines AI generation, a multitrack editor, mastering tools, stem separation, MIDI conversion, notation, DJ and VJ systems, model training, project import, mobile control, and XR features.

The full technical manual explains every backend module, API route, model detail, and development workflow. This version focuses on what a normal user needs to know: what each part of the app does, when to use it, and how the major workflows connect.

For most music-making sessions, the core path is:

**MAKE → EDIT → MIX → LIBRARY**

MAKE creates or transforms audio. EDIT arranges and repairs it. MIX processes and finishes it. The Library stores everything and moves material between the rest of the app.

The other workspaces become useful when you need live performance, visuals, notation, custom models, advanced routing, project conversion, or device control.

---

# 1. Starting theDAW

## Requirements

A normal Windows installation expects the following tools to be installed:

- **uv** for the Python environment and packages
- **Node.js** for the interface and several embedded tools
- **FFmpeg** for audio conversion, export, ingest, and processing
- **Git** for installation, updates, and optional sidecar components
- **A current NVIDIA driver** when using CUDA-based models and GPU tools

Stable Audio Small can run on CPU. Stable Audio Medium requires an NVIDIA CUDA GPU and roughly 8 GB or more of available VRAM.

## Launching on Windows

From the project folder, run:

```powershell
.\theDAW.bat
```

The launcher checks the required tools, prepares the Python environment, installs frontend dependencies when needed, clears stale processes, starts the backend and interface, and opens the app in your browser.

The normal address is:

```text
http://localhost:5173
```

You generally do not need to start the backend and frontend in separate terminals.

If the interface opens but shows **API UNREACHABLE**, the visual app is running but the backend is not responding. Close the launcher and run `theDAW.bat` again before trying more complicated fixes.

---

# 2. Understanding the Main Interface

The main interface stays structurally consistent while you move between workspaces.

## Header

The header contains theDAW logo, the workspace tabs, and four main actions:

- **Mobile Access** shows a local or external address for phones, tablets, Quest, and other devices.
- **? Help** searches features and can locate their actual controls.
- **IMPORT** brings in audio or opens project files.
- **App Menu** contains project, maintenance, device, settings, documentation, and onboarding actions.

## Main workspaces

The top-level workspaces are:

- **MAKE** — AI generation and audio transformation
- **EDIT** — multitrack arrangement and detailed editing
- **MIX** — processing, mastering, plugins, and delivery
- **PERFORM** — scene and clip launching
- **DJ** — two-deck live mixing
- **VJ** — audio-reactive visuals
- **SWAY** — expressive motion-performance system
- **FOUNDRY** — custom plugin-interface builder
- **UNDERFIT** — Stable Audio LoRA training
- **NODEFI** — node-based generation and processing pipelines
- **LOOM** — experimental Shard-based generative system
- **LEARN** — lineage and genealogy of Library assets
- **TOUR** — venue discovery and route planning

## Library rail

The Library lives on the right side of the screen. It can be opened, collapsed, and resized without leaving the current workspace.

Generated songs, imports, mixdowns, stems, MIDI files, recorded audio, and visual media all become Library assets. Most workspaces accept drag-and-drop directly from the Library.

## Bottom dock

The bottom dock holds smaller tools that remain accessible while you work:

- Levels
- Visualize
- MIDI / Piano Roll
- Sequence
- DRAW
- Score
- Sing
- Lyric
- Details
- SLIDE
- SWAY

The processing log appears beside the dock and can be resized independently.

## Global player

The footer player remains visible across the app. It handles normal playback, scrubbing, looping, volume, mute, random playback, fullscreen, and downloading the current Library item.

---

# 3. Help, Docs, HOME, and the Feature Tour

The **?** button is the fastest way to find a feature when you know the task but not the name.

Searching for phrases such as:

```text
separate vocals
```

```text
make guitar tabs
```

```text
send track to DJ
```

returns a plain description, tells you which workspace contains the feature, and can use **LOCATE** to open the right panel and highlight the real control.

The same help area opens the full technical manual. The manual can be read inside the app, downloaded as Markdown, or printed to PDF.

The **HOME** screen is a visual launcher with one card per major workspace plus common actions such as Open Project, Import Audio, and Feature Tour. It can appear at startup or be reopened from the app menu.

The **Feature Tour** is divided into chapters instead of forcing you through one very long walkthrough:

1. Getting started
2. Making music
3. Editing and mixing
4. Performing
5. Words and notes
6. The deep end

Each step changes to the appropriate workspace and highlights the actual control being explained.

---

# 4. Importing Files and Projects

The **IMPORT** button is available in the header from every workspace.

It can import:

- Audio files
- Native `.tasmo` projects
- Supported projects from other DAWs

You can also drag files directly from File Explorer or Finder into many parts of the app.

Audio files can be dropped into:

- The Library
- EDIT tracks
- MAKE Init Audio
- MAKE Inpaint
- MIX
- Chimera
- DJ decks
- Sampler pads
- The Media bucket

Video and image files can be dropped into VJ-related areas.

When an external file is dropped into a workspace, theDAW first registers it in the Library and then places the new Library asset where you dropped it. This prevents one-off files from becoming disconnected from the rest of the project.

---

# 5. MAKE — Generating and Transforming Audio

MAKE supports three main workflows:

- **Text-to-audio** starts from a written prompt.
- **Audio-to-audio** starts from an existing sound.
- **Inpainting / continuation** replaces or extends a selected region.

MAKE also includes Chimera fusion, microphone recording, model selection, templates, saved prompts, spectrograms, and advanced conditioning controls.

## Basic text generation

1. Open **MAKE**.
2. Enter a description in the Prompt field.
3. Choose a model.
4. Set the duration.
5. Press **CREATE**.
6. Listen to the result when it appears in the Library.

A prompt can describe style, instrumentation, tempo, mood, performance, mix character, or sound design.

Example:

```text
155 BPM aggressive trapstep drop, distorted sub bass, metallic percussion,
short orchestral stabs, huge transient drums, sparse vocal chops
```

The prompt does not need to be a paragraph. A clear list of important musical traits is usually easier to control.

## Prompt helper

The sparkle button next to the prompt has two uses:

- When the field is empty, it inserts an example prompt.
- When text already exists, it sends that text to the built-in assistant for optimization.

## Negative Prompt

The Negative Prompt describes what the model should avoid.

Example:

```text
no acoustic guitar, no singing, no crowd noise, no vinyl crackle
```

It is optional. Use it when the generator repeatedly adds an unwanted trait.

---

# 6. Choosing a Generation Engine

The Model menu can switch between several engines.

## Stable Audio 3 Small

Small is the lighter local option. It can run on CPU and supports shorter outputs than Medium. Use it when hardware is limited or when you are rapidly testing prompts.

## Stable Audio 3 Medium

Medium is the larger local model. It requires a CUDA-capable NVIDIA GPU and supports longer outputs. Use it when your system has sufficient VRAM and you want the main higher-capacity local generation path.

## RF checkpoints

`small-rf` and `medium-rf` are primarily training bases for LoRA work. They can run inference with different settings, but they are not the recommended everyday MAKE models.

## Magenta RealTime 2

Magenta RT2 is a separate real-time music engine. Selecting it replaces the normal Stable Audio controls with Magenta-specific conditioning and automatically manages the GPU handoff between the two engines.

## Suno

Suno opens the cloud-generation console. It requires its own API configuration and supports simple generation, custom lyrics and style, covers, and mashups.

## Lyria 3 Pro

Lyria opens its own embedded application inside MAKE. It runs as a separate sidecar rather than being forced into the Stable Audio interface.

---

# 7. MAKE Generation Controls

## Duration

Duration is the requested output length. Short tests are faster and use less memory. Medium supports longer generations than Small.

## Batch

Batch creates several variations from the same settings.

For example:

```text
Batch = 4
```

creates four separate Library entries, each with its own seed.

## Steps

Steps control how many denoising passes the model performs. Normal ARC Stable Audio models are designed around a low step count, approximately 8 by default. RF checkpoints generally need many more steps.

Leave this near the model default unless you are deliberately testing sampler behavior.

## CFG

CFG controls how strongly the model follows the prompt. Normal ARC models use a low value around 1.0. Higher CFG is not automatically better and can introduce artifacts.

## Seed

The seed controls the random starting point.

- `-1` chooses a random seed.
- A fixed seed allows closer reproduction and controlled variation.
- The reroll button creates a new random seed without starting the job.

## Starting and aborting

Press **CREATE** to submit the generation.

The status area shows whether the job is queued, running, completed, or failed. Finished audio can be previewed and is automatically saved to the Library.

While a job is running, CREATE becomes **ABORT**. Aborting stops the interface from waiting for that result. The backend may still finish its work, but the UI discards the run.

---

# 8. Templates, Saved Prompts, and Spectrograms

MAKE can save reusable generation setups.

A template can preserve a useful combination of model, duration, steps, CFG, and other parameters. Saved Prompts preserve frequently reused prompt text.

These are stored locally for quick iteration.

The Spectrogram Viewer can display generated audio as:

- Mel spectrogram
- STFT spectrogram
- Chromagram
- CQT

These views help reveal frequency balance, harmonic movement, and structure when listening alone is not enough.

---

# 9. Init Audio — Audio-to-Audio Generation

Init Audio conditions a new generation on an existing source.

The source can be:

- A generated track
- An imported song
- A microphone take
- A stem
- A Chimera blend
- Any compatible Library asset

Drop the source into the Init Audio area.

## Init Noise

Init Noise determines how strongly the result stays tied to the source.

- **Lower values** preserve more of the original.
- **Higher values** give the model more freedom.

A practical interpretation is:

```text
Low noise = remix or preserve
High noise = reinterpret or transform
```

Remove the Init Audio source to return to normal text-only generation.

---

# 10. Inpainting and Continuation

Inpainting replaces one selected section of an existing audio file while preserving everything around it.

Use it to:

- Repair a bad transition
- Replace a weak drop
- Remove an artifact
- Change a fill
- Rebuild a vocal section
- Create a new ending

## Inpainting workflow

1. Load the source into the Inpaint section.
2. Drag across the waveform to select the region.
3. Check the displayed start and end times.
4. Enter a prompt describing the replacement.
5. Generate.
6. Compare the result with the original.

## Continuation

To extend a song beyond its current ending:

1. Select the end of the source.
2. Set the requested output duration longer than the original.
3. Generate.

The model uses the existing tail as context and creates new audio after it.

---

# 11. Microphone Recording

MAKE includes a browser microphone recorder.

You can record:

- Vocals
- Hummed melodies
- Instruments
- Percussion
- Spoken ideas
- Foley and sound effects

After recording, the take can be:

- Played immediately
- Sent to a new EDIT track
- Appended to an existing EDIT track
- Used as Init Audio
- Used for Inpaint
- Saved to the Library

Once saved in the Library, it can also be analyzed, stem-separated, converted to MIDI, included in lineage, or exported in a bundle.

---

# 12. Chimera Fusion

Chimera combines two or more clips into one shared generation source.

Use it when different references contain different parts of the idea you want:

- One clip has the drums
- One has the bass character
- One has the melody
- One has the arrangement arc

Each source is analyzed when added. Detected BPM and key appear in the stack and are reused during rendering.

## Target BPM

Auto mode derives a target from the source material. You can also force a specific BPM.

## Base clip

A base clip can provide the main tempo or duration reference.

## Influence

Each source has an influence/noise control. Higher noise means less direct influence on the fused result.

## Alignment modes

- **Start** aligns all clips from time zero.
- **Downbeat** lines them up around detected beats.
- **CRISPR / Weave** cuts the inputs into musical chunks and interleaves them across bars.

Weave also lets you control chunk length, total bars, and maximum simultaneous layers.

The finished fusion becomes Init Audio for the next MAKE generation.

---

# 13. LoRA Controls in MAKE

MAKE includes visible controls for stacking LoRA adapters and adjusting their strength.

Current limitation: the standard MAKE generation endpoint does not yet pass all of those LoRA selections into the pipeline. The underlying Stable Audio Python system supports LoRA inference, but the complete UI path is not fully wired.

Use Underfit and the supported Python-side workflow when you need working LoRA training and inference today.

---

# 14. EDIT — Multitrack Arrangement

EDIT is theDAW's traditional timeline.

Use it to:

- Add tracks
- Move clips
- Cut and trim clips
- Create fades
- Adjust volume and pan
- Add effects
- Record automation
- Inpaint a clip region
- Split a clip into stems
- Export the complete arrangement

Editing is non-destructive. Splitting or trimming a clip does not permanently alter the original source file.

---

# 15. EDIT Toolbar and Clip Editing

## Add Track

Creates a new empty track. Track names can follow the first clip placed on them and remain editable.

## Move Tool

Drag a clip horizontally to change its timeline position. Drag vertically to move it to another track.

## Cut Tool

Click inside a clip to split it into two pieces. Both pieces continue referencing the original source.

## Snap

Snap locks movement and resizing to musical divisions:

- Off
- 1/4
- 1/8
- 1/16

## Zoom

Zoom changes the amount of timeline visible on screen.

## Delete

Removes the selected clip. Delete and Backspace also work from the keyboard.

## Trimming

The left clip edge changes both the timeline start and the starting point inside the source. The right edge changes where the clip ends.

## Fades

Fade handles gradually raise or lower the clip level at its beginning or end. Fades are included in preview and export.

---

# 16. Track Controls

Every EDIT track has:

- **Name** — editable track label
- **Mute** — silences the track
- **Solo** — isolates one or more selected tracks
- **Remove** — deletes the track and its clips
- **Volume** — adjusts track gain
- **Pan** — places the track left or right
- **FX** — opens the track's effect chain

These controls affect both normal playback and the final render.

---

# 17. Inpainting From EDIT

You can repair a region without leaving the timeline.

1. Select a clip.
2. Mark a region with the Paintbrush tool or the alternate drag behavior in Move mode.
3. Click **INPAINT REGION**.
4. Enter the prompt, steps, and seed.
5. Generate.

When the new version finishes:

- **Accept** replaces the clip with the regenerated version.
- **Discard** keeps the original.

This review stage lets you audition the repair before committing it.

---

# 18. COMMIT EDIT

COMMIT EDIT renders the entire arrangement to one 44.1 kHz stereo WAV.

The render includes:

- Audible tracks
- Clip positions
- Trims and source offsets
- Volume and pan
- Fade-in and fade-out
- Track effects
- Master effects
- Automation

Muted tracks are excluded. If tracks are soloed, only the solo group is included.

The finished file is automatically added to the Library and downloaded.

---

# 19. EDIT Effects

EDIT supports insert chains on individual tracks and on the EDIT master output.

Built-in effects, VST3 plugins, and `.gan` plugins all appear as entries in the chain. You can add, bypass, reorder, remove, and edit them while audio is playing.

Important built-in effects include:

- Headphone Crossfeed
- Phantom Bass
- Kargyraa Sub
- Stereo Widener
- Aural Exciter
- HRTF Spatializer
- Loudness Contour
- OWL-Pad
- Gater
- Bitcrush
- Ring Mod
- Chop
- Parametric EQ
- Compressor
- High-Pass Filter
- Low-Pass Filter
- Reverb
- Delay
- Ares

## Kargyraa Sub

Kargyraa Sub creates octave-down layers, deeper subharmonics, growl, vowel movement, and focused overtones. It works best on an isolated bass stem because it needs a clear fundamental pitch.

## HRTF Spatializer

The spatializer positions sound around the listener in 3D. Controls include horizontal position, height, distance, movement type, rate, and depth.

Motion modes include orbits, figure-eight movement, up/down motion, spherical movement, Teleport, and Autopilot.

**Teleport** slices the audio around detected events and scatters those slices around the listener.

**Autopilot** reacts to loudness, brightness, bass, onsets, and beat timing to move sound automatically.

---

# 20. Metamorph

Metamorph rebuilds one sound using the identity of another.

Choose:

- **Donor A** for sonic character
- **Host B** for timing and structure

TheDAW reconstructs Host B from grains taken from Donor A.

Controls include Bleed, Grain, Rate, Spray, Match, Sync, Favor, and Gain.

You can preview the morph live and render the result into EDIT as a normal audio clip.

---

# 21. Live MIDI and Automation in EDIT

Piano Roll clips can play as live MIDI during timeline playback. Instrument choice can come from the clip, the track, or the global Piano Roll selection.

If the live instrument is unavailable, theDAW falls back to the clip's rendered audio. The offline EDIT export uses the most recently rendered version of the MIDI clip.

Automation lanes control one parameter at a time, such as track volume, pan, or an effect parameter.

You can:

- Click to add a point
- Drag to move it
- Right-click or Alt-click to delete it

**WRITE** mode records control movement in real time against the EDIT transport. Recorded automation can then be edited and is included in COMMIT EDIT.

---

# 22. Autosave, Recovery, and Stem Separation

EDIT stores a recoverable session while you work. Recovery can include tracks, clips, audio, effects, automation, markers, BPM, and the loop region.

When a recoverable session exists, theDAW asks whether you want to restore it. Autosave pauses until you answer so the previous session is not overwritten.

This is crash protection, not a replacement for Save Project.

To split a clip into stems, right-click it and choose **Separate Stems → Tracks**. Choose the stem count, device, and quality.

When separation finishes:

- Each stem becomes its own track.
- The stems retain the source clip's timing and trim.
- The original clip is muted rather than deleted.

Unmute the original to compare or undo the stem-only playback.

---

# 23. MIX — Processing and Mastering

MIX processes one source file through an ordered effect chain.

Its main areas are:

- Source waveform and file information
- Effect categories
- Effect library
- Active chain
- Output waveform and visualizers

Load a source by clicking or dropping audio into the source area.

## Quick Master

Quick Master exposes broad mastering controls for low end, high end, limiting, and target loudness. It is intended for fast finishing without manually building a long chain.

## Main processing types

MIX includes:

- Compression
- EQ and filters
- Loudness normalization
- Stereo widening
- Reverb and delay
- Pitch shifting
- Tempo change
- Denoising
- Declicking
- Silence removal
- Character effects
- Format conversion

The chain runs from top to bottom. Every entry can be bypassed, reordered, adjusted, or removed.

## Output

Press Process to apply the chain.

The result can be:

- Played
- Downloaded
- Sent to EDIT
- Sent to MAKE Inpaint

Supported output formats include WAV, FLAC, OGG, MP3, AAC, and Opus.

Recent processing results remain available in history.

---

# 24. VST3, .gan, and the Edit Tool Stack

## VST3

The VST category scans standard VST3 locations. Use **Rescan** after installing new plugins.

A supported VST3 becomes a normal chain entry. You can open its native interface and preserve its plugin state.

## .gan plugins

`.gan` is theDAW's browser-based plugin format.

You can load an existing `.gan` or import a Foundry project into one. The plugin runs inside MIX and can provide its own interface and control routing.

## Edit Tool Stack

MIX also exposes specialized processing families beyond the normal effect list:

- **Mastering** — loudness, EQ, limiting, stereo, complete chains
- **Restoration** — denoise, declick, hum removal, cleanup
- **Enhance** — polish, de-crush, enhancement
- **Delivery** — normalization, encoding, output preparation
- **Creative FX** — larger sound-design macros
- **Creative Neural** — pitch, vocoder, granular, and morph tools

Some tools currently use DSP implementations even when their interface names a planned neural engine.

---

# 25. Library Basics

The Library is persistent storage for generated, imported, processed, recorded, separated, and converted material.

Main categories include:

- **Tracks**
- **Stems**
- **MIDI**
- **Video / images**

A Library entry can store audio plus prompt, model, duration, seed, tags, notes, favorite status, rating, analysis, stems, MIDI, and lineage.

You can switch between List and Grid views.

Search can match:

- Title
- Prompt
- Model
- Tags
- Notes

You can filter to favorites and sort by newest, duration, title, or play count.

---

# 26. Library Actions and Details

A normal entry can be:

- Played
- Favorited
- Downloaded
- Deleted
- Sent to EDIT
- Selected for detailed metadata

Right-click actions can include:

- Send to Init Audio
- Send to Inpaint
- Analyze
- Separate stems
- Convert to MIDI
- Download bundle
- Show lineage
- Delete

The Details panel shows title, prompt, model, duration, steps, CFG, seed, timestamp, file size, tags, notes, and source.

When analysis exists, **Prompt Inference** can build a Stable Audio-style prompt from the track's BPM, key, energy, timbre, length, channels, and embedded tags. **USE AS PROMPT** copies that result into MAKE.

---

# 27. Bundles, Stems, MIDI, and Media

## Bundles

A Library bundle can contain the original audio, metadata, analysis, stems, MIDI, and lineage information in one package.

## Stem separation

The standard separator uses Demucs for 2-, 4-, and 6-stem modes.

The 12-stem mode adds another model to split the drum bus into smaller parts such as kick, snare, toms, hi-hat, and cymbals. That mode requires additional pretrained files and may be unavailable until they are installed.

## MIDI conversion

Audio or separated stems can be converted to MIDI using supported transcription engines.

MIDI results can be sent to:

- Piano Roll
- Step Sequencer
- Score

Using stems can improve transcription because the engine receives a cleaner source.

## Video and images

The media Library stores common video and image formats, records dimensions, duration, and transparency, and creates thumbnails. Alpha-capable media can be used as overlays in VJ.

## Format conversion

The Library can convert audio, video, and images between compatible formats. This is separate from MIDI conversion, which turns sound into note data.

---

# 28. Automatic Processing and Playlist Suggestions

Depending on Settings, theDAW can automatically perform analysis, stem separation, lyric processing, MIDI conversion, and notation after an import or generation.

Heavy jobs are coordinated so several GPU-intensive models do not run at the same time. Existing artifacts are reused when possible.

The **SUGGEST** tool builds a playlist from analyzed tracks.

You can choose:

- Target total length
- BPM range
- Flow shape: Steady, Build Up, Wind Down, or Wave
- Harmonic matching
- Genre or text filter

Each suggested track includes a reason for its placement.

You can then:

- **Play All** in the global player
- **Send to DJ** and start an Automix set

Suggestions improve as more Library tracks are analyzed.

---

# 29. Step Sequencer and Piano Roll

## Step Sequencer

The Sequence panel is a 16-step rhythm machine.

Built-in voices include:

- Kick
- Snare
- Hat
- Tone
- Noise

You can set BPM, start or stop playback, randomize the pattern, clear it, add tracks, change voice types, adjust volume, and preview sounds.

The pattern can be:

- Rendered to audio and sent to EDIT
- Exported as one MIDI track
- Exported as one MIDI track per sequencer lane

## Piano Roll

The MIDI panel contains the note editor.

- Pitch runs vertically.
- Time runs horizontally.
- Click to add a note.
- Drag to move it.
- Drag the right edge to resize it.
- Delete removes the selected note.

The Piano Roll supports MIDI import and export and can render the current pattern into EDIT.

Available instruments include a basic synth, General MIDI programs, procedural bass and lead voices, psychoacoustic voices, and Talk-Box vowel voices.

---

# 30. DRAW, Levels, Visualize, Details, and SLIDE

## DRAW

DRAW turns pointer gestures into generated music.

Brushes include:

- Organic
- Fibonacci
- Neural
- Nebulous

The result can be sent to the Library or EDIT. DRAW is best treated as an experimental idea generator rather than a precision editor.

## Levels

Levels reports LUFS loudness, true peak, dynamics, and stereo image. Use it to check whether a mix is excessively loud, clipping, over-compressed, or unstable in stereo.

## Visualize

Visualize reads the shared audio output and displays an oscilloscope, frequency spectrum, or radial visualization. It also reports RMS, peak, sample rate, FFT size, and whether a meaningful signal is present.

## Details and Media

The Details panel can show track metadata, a Library browser, or the temporary Media bucket.

The Media bucket is session-only. Files inside it disappear when the page reloads unless they are sent to the persistent Library.

## SLIDE

SLIDE mirrors compatible VJ controls as faders. Changes move in both directions between SLIDE and VJ. It can also be detached into its own window for a second display or touch device.

---

# 31. Score, Tabs, and Arrangements

A track needs MIDI before most Score functions become available.

## Sheet music

**MAKE SHEET** converts MIDI to MusicXML, handling rhythm quantization, part separation, and time-signature inference.

## Guitar and bass tabs

Choose:

- Guitar or bass
- Tuning
- Capo
- Difficulty

TheDAW tries to choose practical string and fret positions based on hand movement, open strings, fret height, and reach. Notes outside the instrument's range are reported rather than forced into impossible positions.

## Arrangements

Available styles include:

- Lead sheet
- Piano reduction
- Simplified melody
- Band score

## Export

Score can export formats including MusicXML, ABC, PDF, SVG, note chart, and Beat Saber-related output.

PDF and SVG require a notation renderer. theDAW can use its browser-based engraver or MuseScore. If neither is available, those export choices remain visible but disabled with an explanation.

---

# 32. Sing and Lyric

## Sing

Sing displays lyrics in sync with playback.

Lyrics can come from:

- Existing metadata
- Pasted text
- LRC files
- Speech transcription

Main controls:

- **ALIGN** keeps your words and calculates word timing.
- **TAP** lets you manually stamp line timing while listening.
- **AUTO** runs alignment when lyrics exist without timing.
- **PITCH** displays the vocal melody and compares it with microphone input.
- **EXPORT** creates an LRC file.

## Lyric

Lyric is a separate songwriting notebook. It is not tied to one finished Library track.

Use it for drafting, revision, analysis, and manual rhyme marking.

Sing is for synchronized lyric playback and vocal practice. Lyric is for writing.

---

# 33. DJ — Two-Deck Performance

DJ is a two-deck live mixer.

Each deck includes:

- Waveform
- Play and Cue
- Hot cues
- Loops
- Loop roll
- Slip mode
- Beat jump
- Key Lock
- Sync

The center mixer includes:

- Gain
- High, mid, and low EQ
- Filter
- Channel volume
- Pitch faders
- Crossfader
- Quantize
- Auto-gain
- Limiter
- MIDI mode

## Sync, Key Lock, and Quantize

**SYNC** aligns beat timing between decks.

**Key Lock** keeps musical pitch stable when tempo changes.

**Quantize** snaps cues and loops to the beat grid.

## Live stems

A deck can switch from full-track playback into stems:

- Drums
- Bass
- Vocals
- Other

Each stem can be muted, soloed, or level-adjusted while playback continues.

## Headphone cue

A deck can be routed to a separate output device so it can be previewed in headphones while the other deck plays to the audience.

## MIDI Learn

DJ controls can be mapped through known controller profiles, automatic profile matching, or learn-by-moving.

---

# 34. DJ Automix, Sampler, Browser, and Layout

## Automix

Automix moves through a set hands-free.

Prepared tracks can define cue-in, mix-out, and transition length. The assistant can also inspect a running set, start or stop Automix, trigger the next blend, or move a named track to play next.

## Sampler

Drag a clip onto a pad.

Pads can be:

- One-shot
- Looping
- Choke-enabled

Choke mode lets one pad cut another, which is useful for mutually exclusive sounds such as open and closed hi-hats.

## Side List and browser

The Side List stages upcoming tracks.

The browser includes Library, Favorites, Generated, Imports, Online Download, and saved Sets. Tracks or sets can also be sent to VJ.

## Design Mode

Design Mode lets you reorder and resize DJ panels. Layouts can be saved, reset, or exported as JSON.

---

# 35. VJ — Live Visuals

VJ is the audio-reactive visual workspace.

Its visuals can react to:

- Audio
- Microphone
- MIDI
- Camera
- Phone camera
- Quest video
- Screen capture
- Depth data
- Procedural shaders

The audio bridge sends bass, mid, high, and volume values into the visual engine.

The VJ state remains mounted after first use so switching tabs does not reset it. When hidden, its render loop can pause to reduce GPU use.

## Standard inputs

- **Mic** uses microphone input.
- **Audio** follows theDAW's shared playback bus.
- **MIDI** forwards controller messages.
- **Camera** uses any browser-visible webcam or capture device.

Phone and tablet cameras can connect over the local network. Remote devices can use an external tunnel URL.

Capture cards, DSLR webcam modes, OBS Virtual Camera, and similar sources can work when the operating system exposes them as cameras.

---

# 36. VJ Sources, Effects, and Output

## Dedicated sources

VJ includes:

- **delinQuest** for rendered Quest video
- **STITCH** for clean Quest passthrough
- **Cymatics** for procedural reactive scenes
- **Screen / window capture**
- **Shader** scenes such as Mandelbulb, Julia, Mandelbox, Menger, and IFS
- **Kinect and depth point clouds**
- **Spectra** generative visuals
- Video and image Library media

## Effect chain

Effect families include:

- Color and optics
- Geometry and mirroring
- Generative effects
- Depth
- Distortion and glitch
- Time effects
- Post effects such as CRT and ASCII

Effects can be stacked and mapped to controls.

## Autopilot

Autopilot introduces evolving visual behavior such as feedback, glitch, and waveform warp based on the audio.

## Source banks

Useful source states can be stored in bank slots and recalled with one click during a set.

## Pop-out and mobile

VJ can be popped into a separate window for a second monitor or projector. Mobile Access provides a local or external address for remote viewing and camera input.

## Export and broadcast

VJ can record a performance and transcode the result. A local WebRTC watch-link system can also share the output peer-to-peer on the venue network. Some broader public-broadcast components remain in progress.

---

# 37. PERFORM and SWAY

## PERFORM

PERFORM turns a project into a clip-and-scene grid.

- Columns are tracks.
- Rows are scenes.
- Launching a row starts the whole scene.
- Launching one cell changes only that clip.

Launch quantization waits for a musical boundary so changes stay in time.

PERFORM can open native `.tasmo` projects and imported Ableton, Reaper, or Logic projects.

Supported built-in effects can remain active during performance.

## Routing

The Routing panel maps hardware controls to track volume, mute, effect parameters, scene launches, and momentary or latched effect punches.

Mappings are saved with the `.tasmo` project.

## SWAY

SWAY connects the expressive SwayCommand system to theDAW.

Motion dimensions such as strike, sway, pulse, glide, press, and sculpt can drive effects, visuals, clip launching, and performance parameters.

---

# 38. Foundry and Underfit

## Foundry

Foundry is an infinite-canvas builder for custom plugin interfaces.

Create a control surface, export it as a `.gan` plugin, then load that plugin in MIX.

Use Foundry when a custom performance or effect interface is more useful than a normal fixed plugin window.

## Underfit

Underfit is the Stable Audio LoRA training workspace.

A typical training flow is:

1. Prepare audio clips.
2. Add text captions.
3. Choose `small-rf` or `medium-rf`.
4. Set rank, adapter type, and training options.
5. Run training.
6. Save the adapter.
7. Test it through the supported LoRA inference path.

If the training environment is missing, use **Create Environment**.

Adapter families include LoRA, DoRA, BoRA, and parameter-efficient XS variants. If you do not have a specific reason to choose another type, start with the default.

---

# 39. LEARN, Catalogue, NodeF.I., and LOOM

## LEARN

LEARN visualizes the ancestry of Library assets.

Relationships can include:

- Generation
- Import
- Stem separation
- MIDI conversion
- Inpainting
- Chimera fusion
- Cover
- Mashup

Views include a single-track tree, full 2D genealogy, and interactive 3D graph.

## Catalogue

Catalogue is the expanded cross-provider Library browser. It adds larger grid/list views, provider badges, inspector, on-demand spectrograms, lineage, and provider-specific actions.

## NodeF.I.

NodeF.I. builds workflows as connected nodes.

Node types include:

- Library
- Generate
- Effect
- Merge
- Feedback
- Output

Running a graph uses the same generation, processing, and Library systems as manual workflows, so the result becomes a normal Library entry.

## LOOM

LOOM is an experimental Shard-based generative environment. It behaves more like a living system than a normal timeline. It is not required for standard production.

---

# 40. Suno, Magenta, Lyria, and URL Import

## Suno

Suno cloud generation supports:

- Simple
- Custom
- Cover
- Mashup

Completed songs become normal Library entries. Covers and mashups also record lineage.

## Magenta RealTime 2

Magenta supports conditioning from:

- Text
- MIDI notes
- Audio style reference

theDAW handles the GPU swap between Stable Audio and Magenta automatically.

## Lyria 3 Pro

Lyria runs as its own embedded app with its own controls and state.

## URL import

The URL importer can bring supported online audio into the Library. Once imported, it can be edited, used as Init Audio, added to Chimera, stem-separated, converted to MIDI, and included in lineage.

Use this feature only for material you are permitted to download and use.

---

# 41. Projects, Other DAWs, Backup, and Updates

## Native projects

theDAW saves projects as:

```text
.tasmo
```

A `.tasmo` stores project structure and can optionally include referenced audio.

Autosave is for emergency recovery. `.tasmo` is the deliberate project file.

## DAW import

Supported project formats include:

- Ableton Live `.als`
- Reaper `.RPP`
- Logic Pro X `.logicx`

Imported projects can open in PERFORM or EDIT.

Not every proprietary plugin or DAW-specific behavior can be translated exactly. The importer reports limitations and warnings.

## Backup / Migrate

A backup can include:

- Library audio and database
- Stems
- MIDI
- Scores
- Video
- Lineage
- `.tasmo` projects
- Settings

Restore the package on another installation to move the setup.

## Updates

The update path depends on the installation type.

A Git-based install can pull and restart itself. If local uncommitted changes would be overwritten, the update is refused instead of deleting them.

Packaged Windows builds use the installer updater. macOS DMG installs require opening the newly downloaded DMG manually.

---

# 42. Models and Settings

## Which Stable Audio model to use

- **Small** — lighter, CPU-capable, shorter outputs
- **Medium** — CUDA GPU, higher capacity, longer outputs
- **Small RF / Medium RF** — mainly LoRA training bases
- **SAME-S / SAME-L** — standalone autoencoders, normally unnecessary for standard generation

## Model resolution

theDAW looks for models in this order:

1. Registered local folders
2. Hugging Face cache
3. Download, when allowed

## Local-only mode

Fresh installs default to **Local only**.

With it enabled, missing models are not downloaded automatically. Instead, the app explains what is missing and opens Settings to the Models area.

## Hugging Face access

Some models require:

1. Accepting the model license
2. Creating a read token
3. Entering the token in theDAW

## Adding a checkpoint

Use:

**Settings → Models → Add a checkpoint**

Point at the checkpoint folder or `.safetensors` file. Removing the registration does not delete the actual files.

## Other Settings

Settings also controls:

- API keys
- Backend modules
- Layout
- Automatic background processing
- Model locations
- Restart
- Shutdown

---

# 43. Mobile Companion and Quest / XR

## Mobile Companion

The lightweight phone app includes:

- **Make** — start a generation remotely
- **Remote** — control playback
- **DJ** — control the DJ workspace
- **Library** — browse and audition tracks

Connection status appears as Linked, Locked, or Offline.

## Quest / XR

Quest integrations include:

- **delinQuest** — rendered headset video into VJ
- **STITCH** — clean passthrough
- **MIDI bridge** — two-way MIDI between Quest and theDAW
- **Hand-tracked controls** — floating faders, knobs, buttons, and gestures
- **Colocation** — shared spatial alignment across headsets
- **Deploy to Quest** — detect ADB, find the headset, download the APK, install, and launch

Most Quest features require USB debugging or wireless ADB pairing. Quest Link is not required for the main integrations described here.

---

# 44. TOUR — Venue and Route Planning

TOUR is the live-performance planning workspace.

It can:

- Search a region for venues
- Discover promoters and festivals
- Filter venue results
- Gather booking-contact channels
- Build a multi-stop itinerary
- Estimate drive times
- Add EV charging locations

A normal route workflow is:

1. Search for a city or region.
2. Discover venues.
3. Filter and select promising stops.
4. Enrich entries for booking contacts.
5. Add them to the itinerary.
6. Choose a start point and date window.
7. Optimize the route.
8. Review drive legs and charging needs.

The map itself does not require a map key, though some route and enrichment services require configuration.

---

# 45. Assistant and Processing Log

## Assistant

The assistant opens from a draggable floating orb.

Depending on configuration, it can use local or remote providers, attachments, voice input, and theDAW's documentation as retrieval context.

Supported providers can include Claude Code, Gemini, Anthropic, OpenAI, Grok, Groq, OpenRouter, Ollama, LM Studio, llama.cpp, and vLLM.

Remote providers need API keys. Local providers need their local servers running.

## Processing Log

The log reports startup, health, generation, training, MIX, sequencer, Library, and VJ events.

Modes:

- **SIMPLE** hides debug noise and combines repeated messages.
- **VERBOSE** shows every event with timestamp and source.

The log can be downloaded, cleared, collapsed, and set to auto-scroll.

---

# 46. Common Workflows

## Make a song from scratch

1. Open MAKE.
2. Choose Small or Medium.
3. Write the prompt.
4. Set duration.
5. Leave Steps and CFG near defaults unless testing.
6. Use Seed `-1` for random output.
7. Generate several versions.
8. Drag the best version into EDIT.
9. Arrange, cut, layer, and add effects.
10. Use COMMIT EDIT.
11. Load the result into MIX.
12. Master and export.

## Remix an existing song

1. Import the source.
2. Send it to MAKE as Init Audio.
3. Set Init Noise.
4. Describe the new direction.
5. Generate variations.
6. Send the best result to EDIT.
7. Finish the arrangement.
8. Process it in MIX.

## Repair one bad section

1. Load the track into Inpaint.
2. Select the bad region.
3. Describe the replacement.
4. Generate.
5. Compare and revise.

The same workflow can be run directly on an EDIT clip with Accept and Discard.

## Combine several references

1. Add clips to Chimera.
2. Review BPM and key analysis.
3. Set the target BPM.
4. Adjust each source's influence.
5. Choose Start, Downbeat, or Weave.
6. Create the fusion.
7. Use the fusion as Init Audio.
8. Generate the final interpretation.

## Extract vocals or drums

1. Select the Library track.
2. Start stem separation.
3. Choose the stem count.
4. Wait for completion.
5. Open the Stems section.
6. Route the needed part to EDIT, MAKE, Chimera, or DJ.

## Turn audio into MIDI and notation

1. Select or import the track.
2. Separate stems first when helpful.
3. Run MIDI conversion.
4. Open the MIDI in Piano Roll.
5. Edit the notes.
6. Open Score.
7. Create sheet music, tabs, or an arrangement.
8. Export the needed notation format.

## Build a DJ set

1. Analyze Library tracks.
2. Open SUGGEST.
3. Choose duration, BPM range, and flow.
4. Review the proposed order.
5. Send it to DJ.
6. Adjust the queue or prepared transitions.
7. Use Automix or perform manually.

## Create reactive visuals

1. Open VJ.
2. Choose a source.
3. Enable Audio input.
4. Start playback.
5. Add visual effects.
6. Enable BPM sync or Autopilot.
7. Store useful looks in source banks.
8. Pop the output to a second display.
9. Record the performance when needed.

## Train a LoRA

1. Prepare and caption the dataset.
2. Open Underfit.
3. Create the environment if necessary.
4. Choose an RF base model.
5. Set adapter and training options.
6. Run training.
7. Save the adapter.
8. Test it through the supported LoRA inference path.

---

# 47. Troubleshooting

## API UNREACHABLE

Close the launcher and run:

```powershell
.\theDAW.bat
```

The launcher clears stale processes and restarts the stack.

## Medium produces broken or static-like audio

Flash Attention may not match the installed Python, PyTorch, and CUDA environment. Use the project's normal dependency sync instead of manually installing an arbitrary wheel.

## Older NVIDIA card reports an attention error

theDAW can fall back to a compatible attention path on older cards. Update and restart if the app still fails instead of falling back.

## COMMIT EDIT hangs

A source clip may be corrupt or failing to decode. Check the Processing Log, remove the suspicious clip, and try again.

## Underfit stays on Connecting

Use **Create Environment** when the trainer is missing. If setup completed but the panel still cannot connect, inspect the Underfit sidecar log.

## Audio plays at the wrong speed or pitch

Check for a sample-rate mismatch. The main Stable Audio path uses 44.1 kHz stereo.

## Out of VRAM

Try:

- Shorter generation duration
- Stable Audio Small
- Closing other GPU-heavy programs
- Checking for other CUDA processes
- Restarting the backend if memory was not released

## Library uses too much disk space

Delete old generations, stems, video, and other unused Library entries. These are real local files and can consume substantial storage.

---

# 48. Recommended Learning Order

Do not try to learn every workspace at once.

A practical order is:

1. Library
2. MAKE
3. EDIT
4. MIX
5. Stem separation
6. MIDI / Piano Roll
7. Score
8. DJ
9. VJ
10. PERFORM
11. Foundry
12. Underfit
13. LEARN
14. NodeF.I.
15. Mobile, Quest, and TOUR as needed

The central production loop remains:

```text
MAKE → EDIT → MIX → LIBRARY
```

Once that loop feels natural, the rest of theDAW becomes easier to understand because nearly every advanced feature either creates, transforms, organizes, performs, or visualizes material already moving through the same system.
