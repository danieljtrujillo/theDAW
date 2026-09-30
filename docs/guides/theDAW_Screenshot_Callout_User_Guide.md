# theDAW — Screenshot Callout User Guide

This version is designed around annotated screenshots rather than long-form manual pages. Each visible app tab gets one section. Every section includes the screenshot state to capture and short callout text that can sit inside numbered bubbles.

Use the same callout style throughout:

- Put the number beside the real control on the screenshot.
- Keep the bubble headline short.
- Keep the explanation to one or two sentences.
- Show the screen in a useful working state instead of an empty state whenever possible.
- Use a second screenshot only when one screen cannot show the important controls clearly.

---

# SHARED APP SHELL

**Purpose:** Explain the controls that remain available while the user moves between tabs.

**Screenshot state:** Open MAKE with the Library rail and bottom dock visible, one track selected, and the assistant orb visible.

{{ SCREENSHOT: GLOBAL APP SHELL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Main workspace tabs | **Choose a workspace.** Move between generation, editing, mixing, performance, visuals, training, and planning without leaving the app. |
| 2 | Mobile Access button | **Open theDAW on another device.** Copy the local link or scan the QR code from a phone, tablet, or headset. |
| 3 | ? Help button | **Search by task.** Type what you are trying to do and theDAW will explain the feature and locate the real control. |
| 4 | IMPORT button | **Bring files in.** Import audio, open a `.tasmo` project, or load a supported project from another DAW. |
| 5 | App menu | **Projects, settings, and maintenance.** Open, save, back up, update, change themes, restart, or shut down theDAW here. |
| 6 | Right Library rail | **Your shared media collection.** Generated, imported, processed, stem, MIDI, and media files remain available beside every workspace. |
| 7 | Bottom dock | **Open supporting tools.** Meters, MIDI, Sequence, Score, Sing, Lyric, Details, SLIDE, and other panels live here. |
| 8 | Global player footer | **One player across the app.** Play, pause, loop, seek, change volume, and download the currently loaded track. |
| 9 | Floating assistant orb | **Ask inside the app.** The assistant can answer from theDAW documentation and help navigate supported features. |

---

# HOME

**Purpose:** Give new users a simple starting point before they enter the deeper workspaces.

**Screenshot state:** HOME open with all workspace cards visible.

{{ SCREENSHOT: HOME OVERLAY }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Workspace cards | **Jump directly to a workspace.** Each card opens one major part of theDAW. |
| 2 | Open Project | **Continue existing work.** Open a saved `.tasmo` project. |
| 3 | Import Audio | **Start from a file.** Add audio to the Library and begin working with it immediately. |
| 4 | Feature Tour | **Learn on the real interface.** The tour opens tabs and highlights the actual controls. |
| 5 | Show at startup | **Choose your launch behavior.** Turn this off when you no longer need the HOME screen on every start. |
| 6 | Close / Escape area | **Enter the main app.** Dismiss HOME without choosing a card. |

---

# MAKE

**Purpose:** Generate new audio, transform existing audio, replace part of a song, or combine multiple sources.

**Screenshot state:** Use a filled prompt, Stable Audio Medium selected, one Init Audio source loaded, the Inpaint section visible, Chimera containing at least two clips, and one completed output in the status area.

{{ SCREENSHOT: MAKE TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Prompt box | **Describe what you want to hear.** Include genre, tempo, instruments, mood, performance style, or production details. |
| 2 | Sparkle button | **Improve or create a prompt.** With an empty box it inserts an example; with text present it sends the prompt to the assistant for refinement. |
| 3 | Negative Prompt | **Describe what to avoid.** Use this when the model keeps adding unwanted vocals, instruments, noise, or styles. |
| 4 | Model selector | **Choose the generation engine.** Use Stable Audio locally, or switch to Magenta, Suno, or Lyria when those systems are configured. |
| 5 | Duration, Batch, Steps, CFG, Seed | **Control the run.** Set length and variations here; leave Steps and CFG near the model defaults unless you are deliberately experimenting. |
| 6 | Init Audio | **Start from an existing sound.** Lower Init Noise preserves more of the source; higher noise gives the model more freedom. |
| 7 | Inpaint waveform | **Replace only one section.** Drag across the problem area, describe the replacement, and regenerate without rebuilding the entire song. |
| 8 | Chimera stack | **Blend several references.** Combine clips, align their tempo, and control how strongly each source influences the fused result. |
| 9 | Output status | **Track the active job.** See whether the generation is queued, running, complete, or failed, then preview the result. |
| 10 | CREATE / ABORT bar | **Start or stop waiting for a generation.** Finished results are automatically added to the Library. |

### Optional close-up: Chimera

**Screenshot state:** Show detected BPM and key badges, per-source influence, target BPM, and alignment mode.

{{ SCREENSHOT: MAKE — CHIMERA CLOSE-UP }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Target BPM | **Set the shared tempo.** Leave it on Auto or force the blend to a specific BPM. |
| 2 | Base clip | **Choose the main reference.** The base can guide tempo and duration. |
| 3 | Per-clip influence | **Balance the sources.** More noise means less direct influence from that clip. |
| 4 | Alignment mode | **Choose how the clips meet.** Start stacks them, Downbeat aligns beats, and CRISPR / Weave arranges chunks across bars. |
| 5 | Analysis badges | **Use detected musical information.** BPM, key, and beats help theDAW line the sources up before generation. |

---

# EDIT

**Purpose:** Arrange audio on a multitrack timeline, repair sections, apply effects, automate controls, and render a finished arrangement.

**Screenshot state:** Show at least three tracks, several trimmed clips, one fade, one automation lane, and a selected clip.

{{ SCREENSHOT: EDIT TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | ADD TRACK | **Create another layer.** Add tracks for vocals, drums, stems, effects, or alternate versions. |
| 2 | Move, Cut, Snap, and Zoom tools | **Choose how you edit.** Move clips, split them, lock edits to the beat grid, or zoom for detail. |
| 3 | Track controls | **Mix each track.** Rename, mute, solo, remove, change volume, pan, or open the track's effect chain. |
| 4 | Clip body | **Move the audio in time.** Drag horizontally to change timing or vertically to move it to another track. |
| 5 | Trim and fade handles | **Shape the clip edges.** Trim the source region and add smooth fade-ins or fade-outs. |
| 6 | Playhead and ruler | **Choose the playback position.** Click the timeline to move the playhead and use the ruler to judge timing. |
| 7 | Automation lane | **Change a control over time.** Draw breakpoints or record live movement with WRITE mode. |
| 8 | INPAINT REGION | **Repair part of a selected clip.** Generate a replacement, audition it, then Accept or Discard it. |
| 9 | FX rack button | **Build a processing chain.** Add built-in effects, VST3 plugins, or `.gan` plugins to a track or the EDIT master. |
| 10 | COMMIT EDIT | **Render the full arrangement.** Volume, pan, fades, effects, and automation are baked into a new Library file. |

### Optional close-up: EDIT effects

**Screenshot state:** Open a track effect rack with several effects and one floating control window.

{{ SCREENSHOT: EDIT — FX RACK CLOSE-UP }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Add Effect | **Add another processor.** Built-ins, VST3, and `.gan` plugins share the same chain. |
| 2 | Chain order | **Processing runs from top to bottom.** Reordering effects can substantially change the result. |
| 3 | Bypass | **Compare with and without the effect.** Bypass keeps the settings but temporarily removes the processing. |
| 4 | Effect window | **Edit the selected processor.** Leave control windows open while you continue working on the timeline. |
| 5 | Automation target | **Automate effect parameters.** A parameter can receive its own editable lane on the timeline. |

---

# MIX

**Purpose:** Process and master one audio file through an ordered effect chain.

**Screenshot state:** Load a source track, show the Mastering category, several active effects, Quick Master, and a processed result.

{{ SCREENSHOT: MIX TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Source waveform | **Load the track to process.** Click, drop a file, or drag a Library item into this area. |
| 2 | Source statistics | **Check the input before processing.** Duration, sample rate, peak, and RMS help identify obvious problems. |
| 3 | Category rail | **Narrow the effect library.** Browse Studio, Magenta, VST, Plugins, mastering, dynamics, EQ, cleanup, export, and more. |
| 4 | Effect library | **Choose a processor.** Clicking an item adds it to the active chain. |
| 5 | Quick Master | **Apply broad finishing moves quickly.** Shape punch, air, drive, ceiling, and loudness without building the chain from scratch. |
| 6 | Active chain | **Control the processing order.** Reorder, bypass, adjust, or remove any chain entry. |
| 7 | Output format | **Choose the delivery file.** Export WAV, FLAC, OGG, MP3, AAC, or Opus. |
| 8 | Process control | **Run the complete chain.** The processed result can be played, downloaded, sent to EDIT, or sent to Inpaint. |
| 9 | Output waveform and visualizers | **Compare the result.** Review the processed file and watch its level or frequency behavior. |
| 10 | History | **Return to a recent result.** Previous processing passes can be promoted back into the source position. |

---

# PERFORM

**Purpose:** Launch project clips and scenes live instead of playing a fixed left-to-right arrangement.

**Screenshot state:** Load a project containing several tracks and scenes, with Routing open.

{{ SCREENSHOT: PERFORM TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Project path and Browse | **Choose the project to perform.** Open a `.tasmo` file or import a supported DAW project. |
| 2 | Recent projects dropdown | **Reopen recent sets quickly.** Use the keyboard or click an entry to load it. |
| 3 | Track columns | **Each column is one track.** A track can keep playing while you change another part of the scene. |
| 4 | Scene rows | **Launch a full arrangement state.** Triggering a row starts all of that scene's clips together. |
| 5 | Individual clip cell | **Change one part without changing everything.** Launch a single clip over the currently playing scene. |
| 6 | Launch Quantize | **Keep changes on the beat.** New clips wait for the next musical boundary before starting. |
| 7 | Live effect chain | **Perform with the project effects active.** Supported effects remain available on each track. |
| 8 | Routing toggle and SwayCommand deck | **Map hardware and gestures.** Bind controls to volume, mute, effect parameters, scenes, or temporary effect punches. |
| 9 | `.tasmo` action | **Save the performance setup.** Routing and mappings can travel with the project. |
| 10 | Edit Timeline | **Move from performance to detailed editing.** Open the imported session as tracks and clips in EDIT. |

---

# DJ

**Purpose:** Mix two tracks live with beat sync, cueing, stems, effects, automix, and sampler controls.

**Screenshot state:** Load tracks on both decks, show the center mixer, stem controls, sampler, and Side List.

{{ SCREENSHOT: DJ TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Deck waveforms | **See beats, hot cues, and playback position.** Use the waveform to anticipate transitions and phrase changes. |
| 2 | Play, Cue, Hot Cues, and Loops | **Control each deck.** Start, preview, jump to saved points, or repeat a musical section. |
| 3 | SYNC and Key Lock | **Match tempo without changing pitch.** SYNC locks the beat; Key Lock keeps the song in its musical key. |
| 4 | Pitch faders | **Adjust deck speed manually.** Use these when you want hands-on tempo control instead of full sync. |
| 5 | Channel mixer | **Shape each deck before the blend.** Gain, EQ, filter, and channel volume prepare the transition. |
| 6 | Crossfader | **Blend Deck A and Deck B.** Move between tracks or hold both in the mix. |
| 7 | Live Stems | **Mix the song's parts separately.** Mute, solo, or ride vocals, drums, bass, and other while playback continues. |
| 8 | Per-deck FX | **Add performance effects.** Process one deck without changing the other. |
| 9 | Headphone Cue | **Preview privately.** Route a deck to a separate output while the audience hears the main mix. |
| 10 | Side List and Automix | **Prepare what plays next.** Reorder the queue or let Automix follow the planned transitions. |
| 11 | Sampler pads | **Trigger one-shots or loops.** Choke mode lets one pad cut another. |
| 12 | Edit Layout | **Rebuild the console around your setup.** Move and resize panels, then save or reset the layout. |

---

# VJ

**Purpose:** Create and perform live visuals from audio, cameras, media, shaders, depth sources, and Quest feeds.

**Screenshot state:** Show a live visual, the source selector, Audio input enabled, an effect chain, banks, and Autopilot.

{{ SCREENSHOT: VJ TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Main visual output | **This is the final composited frame.** It can stay inside theDAW or move to another display. |
| 2 | Input toggles | **Choose what drives the visuals.** Use audio, microphone, MIDI, camera, or a combination. |
| 3 | Source selector | **Choose the visual material.** Use clips, images, cameras, shaders, cymatics, point clouds, screen capture, or Quest feeds. |
| 4 | Audio bridge status | **React to the music.** Bass, mids, highs, and volume are continuously sent into the visual engine. |
| 5 | Source controls / crossfader | **Blend visual sources.** Mix between compatible inputs instead of cutting instantly. |
| 6 | Source banks | **Store and recall looks.** Save useful sources or clips into bank slots for live access. |
| 7 | Effect chain | **Stack visual processing.** Combine color, geometry, depth, glitch, time, feedback, CRT, ASCII, and other effects. |
| 8 | BPM Sync | **Keep motion in time.** Visual timing can follow the music or the active DJ deck. |
| 9 | Autopilot | **Let the look evolve automatically.** Audio-reactive effects can appear and change without constant manual control. |
| 10 | Pop Out | **Send visuals to another screen.** Keep the controls on the main display and move the output to a projector or second monitor. |
| 11 | Mobile / QR | **Open the visual system remotely.** A phone, tablet, or headset can connect through the local or external URL. |
| 12 | Record / Export | **Capture the performance.** Save the visual output and transcode it to the selected format. |

### Optional close-up: VJ sources

{{ SCREENSHOT: VJ — SOURCE SELECTOR CLOSE-UP }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Camera | **Use any browser-visible camera.** Webcams, capture cards, virtual cameras, and phone feeds can become sources. |
| 2 | delinQuest | **Stream the Quest's rendered view.** Choose a single eye or side-by-side 3D feed. |
| 3 | STITCH | **Use clean Quest passthrough.** This source separates the real-world composite from the normal performer overlay. |
| 4 | Shader | **Run procedural scenes.** Switch fractals and material styles, then map parameters to audio or controls. |
| 5 | KINECT / DEPTH | **Build a point cloud.** Recenter, move, rotate, and scale the cloud in the output. |
| 6 | Screen Capture | **Turn another app or monitor into a visual source.** Select it through the browser capture prompt. |

---

# SWAY — MAIN WORKSPACE

**Purpose:** Use the SwayCommand performance system and expressive-motion controls at full size.

**Screenshot state:** Show an active Sway project, the hardware visualization, and live motion values.

{{ SCREENSHOT: SWAY WORKSPACE }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Current project | **Open the performance setup.** SWAY loads the latest saved project or the bundled starting project. |
| 2 | Hardware / cockpit view | **See the performance controls as a system.** The layout represents the connected Sway workflow rather than a normal DAW timeline. |
| 3 | Strike, Sway, Pulse, Glide, Press, Sculpt | **Use six expressive motion channels.** Each dimension can drive a different performance behavior. |
| 4 | MIDI status | **Share the controller across theDAW.** MIDI is received centrally so SWAY and the rest of the app can respond together. |
| 5 | Project save | **Keep the setup durable.** Saved projects reopen with their media and mappings intact. |
| 6 | Shared motion bus | **Control more than SWAY.** Motion data can also drive VJ parameters and PERFORM mappings. |

---

# FOUNDRY

**Purpose:** Design custom plugin and performance interfaces, then export them as `.gan` plugins.

**Screenshot state:** Show a populated canvas, component palette, selected control, inspector, and export controls.

{{ SCREENSHOT: FOUNDRY TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Infinite canvas | **Build the interface visually.** Arrange controls without being locked to a fixed panel size. |
| 2 | Component palette | **Add knobs, faders, buttons, displays, and other interface parts.** |
| 3 | Selected component | **Position and size the control.** The canvas is the final plugin surface. |
| 4 | Inspector | **Edit the selected control.** Change its label, range, behavior, styling, and target. |
| 5 | Preview / interaction mode | **Test the interface before export.** Verify that the controls behave as expected. |
| 6 | Export | **Create a `.gan` plugin.** Load the exported file into MIX or an EDIT effect chain. |
| 7 | Pop Out | **Use a larger design surface.** Open Foundry in its own browser window when the embedded view feels cramped. |

---

# UNDERFIT

**Purpose:** Prepare datasets and train Stable Audio LoRA adapters from inside theDAW.

**Screenshot state:** Show the training dashboard with dataset, base model, adapter settings, progress, and output path visible.

{{ SCREENSHOT: UNDERFIT TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Status / setup area | **Check whether the trainer is ready.** A new machine can build the required environment from this tab. |
| 2 | Dataset path | **Choose the training material.** Use audio clips paired with useful text captions. |
| 3 | Base model | **Choose the training foundation.** Use `small-rf` or `medium-rf`, not the normal ARC inference checkpoint. |
| 4 | Adapter type | **Choose how the LoRA learns.** The default is the safest starting point when you do not need a specialized adapter. |
| 5 | Rank, alpha, dropout, and layer filters | **Control capacity and scope.** These settings determine how much the adapter can learn and where it is applied. |
| 6 | Training controls | **Start, pause, resume, or stop the run.** Watch the live state instead of managing a separate terminal. |
| 7 | Progress and logs | **Monitor the run.** Use the loss, step, and log information to spot failures or overtraining. |
| 8 | Output adapter | **Save the trained LoRA.** The resulting adapter can be loaded through the supported Stable Audio inference path. |
| 9 | Open externally / reload | **Recover the embedded dashboard.** Reload it or open the same trainer in a full browser tab. |

---

# NODEFI

**Purpose:** Build repeatable generation and processing workflows by connecting nodes.

**Screenshot state:** Show a graph containing Library, Generate, Effect, Merge, and Output nodes with one selected.

{{ SCREENSHOT: NODEFI TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Node palette | **Add a workflow step.** Sources, generation, effects, merges, feedback, and outputs are available as nodes. |
| 2 | Canvas | **Arrange the pipeline visually.** Pan and zoom around larger graphs. |
| 3 | Node ports and connections | **Define the data flow.** Drag between ports to decide what feeds the next step. |
| 4 | Selected node | **See one step's live state.** A node reports whether it is waiting, running, complete, or failed. |
| 5 | Inspector | **Edit the node's settings.** A Generate node can have its own prompt, model, duration, seed, and other parameters. |
| 6 | Run | **Execute the graph.** TheDAW uses the same generation, effect, and Library systems as the normal workspaces. |
| 7 | Output node | **Save the final result.** Completed graph outputs become normal Library entries. |

---

# LOOM

**Purpose:** Explore the Shard Index as an evolving generative colony rather than a normal linear arrangement.

**Screenshot state:** Capture LOOM while the colony is actively evolving, with the current generation visible.

{{ SCREENSHOT: LOOM TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Main colony view | **Watch the system evolve.** LOOM grows a new generation on each bar. |
| 2 | Current shard / generation area | **Inspect the active state.** Use this to understand which part of the colony is currently developing. |
| 3 | Timing or bar state | **Follow the generational clock.** Musical bars drive the colony's changes. |
| 4 | Available shard controls | **Shape the evolution.** Use the visible LOOM controls to influence the current colony rather than arranging clips on a timeline. |
| 5 | Save or send action | **Move useful results into the wider app.** Preserve material you want to continue developing elsewhere. |

---

# LEARN

**Purpose:** Visualize how every track, stem, MIDI file, remix, inpaint, and generated version is related.

**Screenshot state:** Show the 3D graph with a selected node and the view controls visible.

{{ SCREENSHOT: LEARN TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | View selector | **Choose the scale of the history.** Track shows one family, Genealogy shows the 2D Library tree, and 3D shows the full graph. |
| 2 | Selected node | **Inspect one asset.** A node can represent a track, stem, MIDI file, or other derived item. |
| 3 | Parent and child nodes | **See where it came from and what came next.** Follow the chain through remixes, stems, inpaints, conversions, and generations. |
| 4 | Colored connections | **Read the relationship type.** Edge colors distinguish different transformations. |
| 5 | Appearance presets | **Change how the graph is presented.** Use coordinated visual styles when the graph becomes dense. |
| 6 | Fit / Reset / Fullscreen | **Navigate a large genealogy.** Reframe the graph or expand it to the full viewport. |
| 7 | Node details | **Open the underlying Library item.** Use the selected asset's metadata to continue working with it. |

---

# TOUR

**Purpose:** Discover venues and contacts, then build an efficient live-performance route.

**Screenshot state:** Search a city, populate the venue list, select several route stops, and show EV mode.

{{ SCREENSHOT: TOUR TAB }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Region search | **Choose where to look.** Search for a city, region, or touring area. |
| 2 | Map | **See venues and the planned route geographically.** Selecting a venue centers it here. |
| 3 | Venue list | **Review discovered locations.** The list stays connected to the map selection. |
| 4 | Genre and vibe filters | **Narrow the search.** Keep only the venues that fit the act or event. |
| 5 | Enrich action | **Find booking channels.** Gather public contact information for a selected venue. |
| 6 | Route itinerary | **Build the run of shows.** Add stops and review the proposed order. |
| 7 | Start point and date window | **Set the practical boundaries.** These values frame the route plan. |
| 8 | Optimize route | **Reduce unnecessary travel.** The itinerary is reordered and drive times are calculated. |
| 9 | EV / gas mode | **Plan around the vehicle.** EV mode adds charging locations along the route. |

---

# LIBRARY / CATALOGUE

**Purpose:** Browse, organize, route, analyze, and reuse everything stored in theDAW.

**Screenshot state:** Show the Library expanded with Tracks, Stems, MIDI, and Video tabs, one selected entry, filters, and a context menu.

{{ SCREENSHOT: LIBRARY / CATALOGUE }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Tracks, Stems, MIDI, Video | **Switch between asset types.** Each type remains a first-class item with its own actions. |
| 2 | Search | **Find material by metadata.** Search title, prompt, model, tags, or notes. |
| 3 | Favorites and Sort | **Narrow and reorder the collection.** Sort by newest, duration, title, or plays. |
| 4 | Track row or card | **Select an item.** Selection updates Details and makes the asset available to other workspaces. |
| 5 | Play, Favorite, Download, Delete | **Use the common actions directly.** You do not need to open a separate file browser. |
| 6 | Right-click menu | **Route or transform the asset.** Send it to EDIT, Init, Inpaint, Chimera, stems, MIDI, lineage, or download tools. |
| 7 | Provider badge | **See where the item came from.** Catalogue can distinguish local generations, cloud providers, and imports. |
| 8 | Inspector / spectrogram | **Review deeper information.** Open analysis, visualizations, and lineage without leaving Catalogue. |
| 9 | SUGGEST | **Build a compatible playlist.** Set the length, BPM range, energy flow, harmonic behavior, and optional text filter. |
| 10 | Expand / resize rail | **Choose how much Library space you need.** Keep it narrow beside a workspace or expand it into Catalogue. |

---

# LEVELS

**Purpose:** Check loudness, peaks, dynamics, and stereo behavior before delivery.

**Screenshot state:** Play a mastered track so all meters show active readings.

{{ SCREENSHOT: LEVELS PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | LUFS | **Measure perceived loudness.** Use this instead of judging final level only by the peak meter. |
| 2 | True Peak | **Check delivery headroom.** A high dBTP reading can warn about clipping during playback or conversion. |
| 3 | Dynamics | **See how compressed the track feels.** Very low dynamics can indicate an over-limited mix. |
| 4 | Stereo image | **Check width and stability.** Use this to catch a mix that is too narrow, too wide, or phase-problematic. |
| 5 | Live state | **Read the active master bus.** The meters update from the same signal used by the player. |

---

# VISUALIZE

**Purpose:** View the current audio signal as waveform and frequency data.

**Screenshot state:** Play a full-spectrum track and use Spectrum mode.

{{ SCREENSHOT: VISUALIZE PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | O / S / R controls | **Choose the display.** Switch between Oscilloscope, Spectrum, and Radial views. |
| 2 | Main canvas | **Watch the shared output in real time.** This follows audio from different parts of theDAW. |
| 3 | RMS | **See the average signal level.** RMS is useful for judging sustained energy. |
| 4 | Peak | **See the strongest moment.** Use it to catch sudden level spikes. |
| 5 | LIVE / SILENT | **Confirm whether meaningful audio is reaching the analyzer.** |
| 6 | Fullscreen / settings | **Expand or tune the visualization.** Use fullscreen when the display is part of a performance setup. |

---

# MIDI / PIANO ROLL

**Purpose:** Edit musical notes directly, choose instruments, import MIDI, and render note data into audio.

**Screenshot state:** Show a populated MIDI pattern, the keyboard, instrument selector, and playback controls.

{{ SCREENSHOT: MIDI / PIANO ROLL PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Piano keyboard | **Read pitch vertically.** Higher notes are above lower notes. |
| 2 | Time grid | **Place notes in time.** The horizontal grid follows the selected BPM and step length. |
| 3 | MIDI note | **Edit the performance.** Drag to move it, resize the right edge, or delete it. |
| 4 | BPM and Total Steps | **Set tempo and loop length.** Longer patterns extend horizontally. |
| 5 | Instrument selector | **Choose how the notes sound.** Use the basic synth, General MIDI, procedural voices, psychoacoustic sounds, or talk-box voices. |
| 6 | Play / Stop | **Preview the note pattern.** Playback routes through the shared audio engine. |
| 7 | Import MIDI | **Open an existing `.mid` file.** Imported notes replace the current pattern. |
| 8 | Export MIDI | **Save the edited note data.** Keep the performance editable outside theDAW. |
| 9 | Send to EDIT | **Turn the pattern into an audio clip.** The rendered part appears on a new EDIT track. |

---

# SEQUENCE

**Purpose:** Build quick 16-step drum and rhythm patterns.

**Screenshot state:** Show at least five lanes with an active pattern and the playback step moving.

{{ SCREENSHOT: SEQUENCE PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | BPM | **Set the pattern speed.** Every step represents a sixteenth note. |
| 2 | Play / Stop | **Start or stop the sequencer clock.** |
| 3 | Step buttons | **Build the rhythm.** Click a step to turn that hit on or off. |
| 4 | Voice chip | **Change the lane sound.** Cycle through kick, snare, hat, tone, and noise. |
| 5 | Track volume | **Balance the pattern.** Each lane has its own level. |
| 6 | Random Fill | **Generate a new pattern quickly.** Use it as a starting point, then edit the steps. |
| 7 | Clear | **Reset the pattern.** All steps are turned off. |
| 8 | Add Track | **Add another rhythmic lane.** |
| 9 | Send to EDIT | **Render the pattern as audio.** Continue arranging and processing it on the timeline. |
| 10 | MIDI Export | **Keep the pattern as notes.** Export one combined track or one MIDI track per lane. |

---

# DRAW

**Purpose:** Turn mouse, pen, or touch gestures into generative musical material.

**Screenshot state:** Show a completed stroke, brush selection, and an active generated result.

{{ SCREENSHOT: DRAW PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Drawing canvas | **Draw the musical gesture.** Position, direction, and movement become part of the result. |
| 2 | Organic brush | **Grow melodic material from the stroke.** |
| 3 | Fibonacci brush | **Create interval and spiral-based motion.** |
| 4 | Neural brush | **Use a network-styled generative voice.** |
| 5 | Nebulous brush | **Create diffuse pads and textures.** |
| 6 | Sound mode | **Choose the sound engine.** Use drone, SoundFont, or granular playback. |
| 7 | Record / Send | **Keep the result.** Save it to the Library or place it on the EDIT timeline. |

---

# SCORE

**Purpose:** Turn MIDI into sheet music, tablature, arrangements, and exportable notation files.

**Screenshot state:** Show one rendered score, the artifact list, Tabs controls, and Export menu.

{{ SCREENSHOT: SCORE PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Artifact list | **Choose the notation file.** MIDI, MusicXML, tabs, PDF, SVG, and other results are stored with the track. |
| 2 | Score preview | **Review the written music.** Sheet music and tabs render directly inside the app. |
| 3 | MAKE SHEET | **Convert MIDI into MusicXML.** Rhythm, parts, and time signature are prepared automatically. |
| 4 | Tabs controls | **Create guitar or bass tablature.** Choose the instrument, tuning, capo, and difficulty. |
| 5 | Arrangement style | **Reformat the music for a purpose.** Create a lead sheet, piano reduction, simplified part, or band score. |
| 6 | Part selector | **Export one part or the whole score.** |
| 7 | Export format | **Choose the notation file.** MusicXML, ABC, PDF, SVG, note chart, and supported game formats are available. |
| 8 | Download | **Save the selected artifact.** Exports remain linked to the source track. |

---

# SING

**Purpose:** Display synchronized lyrics, align words, transcribe vocals, and practice pitch.

**Screenshot state:** Show a song playing with word-level highlighting, lyrics and score visible, and the main action buttons.

{{ SCREENSHOT: SING PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Synchronized lyrics | **Follow the song in real time.** Lines and words move with playback. |
| 2 | Lyrics / Both / Score / Study | **Choose the reading layout.** View lyrics, notation, or the song analysis beside them. |
| 3 | ALIGN | **Time your existing words automatically.** TheDAW keeps the lyrics and finds where they occur. |
| 4 | TAP | **Set line timing by hand.** Tap each line as the song plays. |
| 5 | AUTO | **Align automatically when a song opens.** Use this for tracks that already contain lyrics but no timing. |
| 6 | Transcription source | **Let speech recognition write the lyrics.** Use this when no lyric text exists. |
| 7 | PITCH | **Practice against the vocal melody.** The microphone input can be compared with the detected pitch. |
| 8 | EXPORT | **Save timed lyrics.** Export an LRC file for compatible players and tools. |

---

# LYRIC

**Purpose:** Write and analyze lyric drafts that are not tied to one finished Library track.

**Screenshot state:** Show a populated notebook document, analysis beside it, and visible rhyme markings.

{{ SCREENSHOT: LYRIC PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Notebook | **Write the lyric directly.** This document remains separate from a finished song. |
| 2 | Draft selector | **Move between lyric documents.** Keep alternate versions without replacing the current one. |
| 3 | Analysis pane | **Review structure and language.** Use the analysis while revising the draft. |
| 4 | Rhyme marking | **Mark the relationships you care about.** Manual marks are stored with the document. |
| 5 | Save state | **Keep the draft independent.** It does not need a Library audio track to exist. |

---

# DETAILS

**Purpose:** Inspect and edit the metadata for the selected Library item.

**Screenshot state:** Show a selected generated track with full metadata, Prompt Inference, and the side-by-side Library layout.

{{ SCREENSHOT: DETAILS PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Title and source | **Identify the selected asset.** See its name and whether it was generated, imported, mixed, or recorded. |
| 2 | Prompt and Negative Prompt | **Review the original generation instructions.** |
| 3 | Model, Steps, CFG, Seed | **See the settings behind the result.** These are useful when creating related versions. |
| 4 | Tags and Notes | **Add your own organization.** These fields are searchable in the Library. |
| 5 | Play / Send to EDIT / Download | **Use the selected item immediately.** |
| 6 | Prompt Inference | **Turn analysis into a new prompt.** Copy the inferred musical description directly into MAKE. |
| 7 | Library / Media switch | **Choose what fills the right column.** Browse the permanent Library or the temporary Media bucket. |
| 8 | Side-by-side Library list | **Select another track without closing Details.** The metadata follows the current selection. |

---

# SLIDE

**Purpose:** Control VJ and other published parameters from a touch-friendly fader surface.

**Screenshot state:** Show several populated faders, the content selector, and detach control.

{{ SCREENSHOT: SLIDE PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Control capsules | **Move the published parameters.** Each fader is linked to a real control in the connected system. |
| 2 | Live value | **See the current setting.** Changes from either side stay synchronized. |
| 3 | Content selector | **Switch the visible control set.** |
| 4 | Two-way sync | **Control from either interface.** Moving a VJ control updates SLIDE, and moving SLIDE updates VJ. |
| 5 | Detach | **Open SLIDE on another display.** This is useful for touchscreens and dedicated performance control. |
| 6 | Maximize | **Fill the available panel space.** Use a larger surface when precise fader movement matters. |

---

# SWAY — BOTTOM PANEL

**Purpose:** Keep the SwayCommand cockpit and motion system available while another main workspace stays open.

**Screenshot state:** Show the docked SwayCommand view while VJ or PERFORM remains active above it.

{{ SCREENSHOT: SWAY BOTTOM PANEL }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Embedded cockpit | **Control SWAY without leaving the current workspace.** |
| 2 | Active project | **Use the latest saved setup or the bundled starting project.** |
| 3 | Motion values | **Monitor Strike, Sway, Pulse, Glide, Press, and Sculpt live.** |
| 4 | MIDI link | **Share controller input with theDAW.** The main app remains the central MIDI owner. |
| 5 | Save | **Write the project to disk.** Media paths and project state remain available on reopen. |
| 6 | VJ / PERFORM connection | **Use motion as a modulation source.** The same gestures can drive visuals and performance mappings. |

---

# APP MENU

**Purpose:** Collect project, maintenance, device, appearance, settings, and help actions in one place.

**Screenshot state:** Open the full menu with all groups visible.

{{ SCREENSHOT: APP MENU }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Project group | **Start, open, save, or import a project.** |
| 2 | Data group | **Back up, migrate, update, or restore.** |
| 3 | Devices group | **Deploy theDAW-XR to a Quest headset.** |
| 4 | App group | **Change layout, theme, settings, or open Docs.** |
| 5 | Help group | **Start the tour, manage feature notes, or reopen HOME.** |
| 6 | Edit Layout state | **See whether layout editing is active.** The accent indicator remains visible while Design Mode is on. |

---

# SETTINGS — MODELS

**Purpose:** Show whether the main engines are ready and control where models come from.

**Screenshot state:** Open Settings directly to Models with Local Only enabled, one installed checkpoint, and the engine cards visible.

{{ SCREENSHOT: SETTINGS — MODELS }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Local Only | **Prevent surprise downloads.** Missing models fail clearly until you explicitly allow downloading. |
| 2 | Stable Audio card | **See the local generation status.** Active, ready, cached, blocked, or missing states appear here. |
| 3 | Magenta, Suno, Demucs, and MIDI cards | **Check the supporting engines.** Setup and key problems are visible in one place. |
| 4 | Add a checkpoint | **Register a model already on disk.** Browse to its folder or `.safetensors` file. |
| 5 | Inspect / Generate Config | **Diagnose incomplete checkpoints.** Known models can recover an official local config when available. |
| 6 | Model locations | **See where space is being used.** Open caches, local model folders, Library storage, and related assets. |
| 7 | Hugging Face sign-in | **Unlock gated checkpoints.** Paste a read token after accepting the model license. |
| 8 | LOAD / model readiness | **Prepare the model before generation.** The resolution trail shows exactly where every required file came from. |

---

# PROCESSING LOG

**Purpose:** Show what theDAW is doing and provide useful error information.

**Screenshot state:** Show a mixture of normal, warning, and error messages with SIMPLE mode active.

{{ SCREENSHOT: PROCESSING LOG }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Message stream | **Follow generation, processing, Library, VJ, and system activity.** |
| 2 | Severity marker | **See whether an event is informational, a warning, or an error.** |
| 3 | SIMPLE / VERBOSE | **Choose clean output or full diagnostic detail.** |
| 4 | Repeated-message count | **Keep noisy events compact.** SIMPLE mode combines identical consecutive lines. |
| 5 | Download | **Save the complete raw log.** The export includes entries hidden by SIMPLE mode. |
| 6 | Clear / Collapse | **Reset or hide the panel.** |

---

# MOBILE COMPANION

**Purpose:** Control selected parts of theDAW from a phone without loading the full desktop application.

**Screenshot state:** Show the Remote tab with the bottom mobile navigation and Linked status visible.

{{ SCREENSHOT: MOBILE COMPANION }}

| # | Point to | Bubble text |
|---|---|---|
| 1 | Link status | **Confirm the connection.** Linked is ready, Locked was rejected, and Offline cannot reach the desktop. |
| 2 | Make tab | **Start a generation remotely.** The desktop performs the actual work. |
| 3 | Remote tab | **Control the global player.** Use the phone as a transport remote. |
| 4 | DJ tab | **Operate supported DJ controls from across the room.** |
| 5 | Library tab | **Browse and audition the disk-backed Library.** |
| 6 | Pairing URL | **Connect to the correct desktop session.** Open the link provided by Mobile Access. |

---

# USING THIS COPY WITH SCREENSHOTS

For the finished visual guide, keep each section on one or two pages:

1. Put the screenshot at the center.
2. Place numbered markers on the actual controls.
3. Arrange the matching bubbles around the screenshot.
4. Keep the **Purpose** sentence as the page subtitle.
5. Remove the **Point to** column from the public version; it is production guidance for the designer.
6. Use the optional close-up only when the full-screen screenshot makes a control too small to understand.
7. Do not turn every minor setting into a callout. The callouts above cover the primary user decisions and workflows for each tab.
