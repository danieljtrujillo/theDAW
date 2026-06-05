# DJ Suite & Genealogy Workspace — Guide

Reference for two of theDAW's larger subsystems: the DJ tab and the Library's
genealogy/lineage views. Plain descriptions of what each control does.

## DJ tab — decks

The DJ tab has two decks (A and B). Load a track by dragging it from the Source
Tree / track browser onto a deck, or use the play-next lane.

- **Hero waveform** — the full-width scrolling overview of the loaded track, shown above the decks.
- **Jog wheel** — the platter scrubs/nudges the track; the outer ring is the pitch (tempo) fader.
- **Transport** — Cue sets/returns to a cue point; Play/Pause; Sync beat-matches to the other deck.
- **Hotcues** — four pads per deck save and jump to cue points.
- **Loops & roll** — set a beat-length loop (1/4 to 4 beats); roll/stutter repeats a slice while held.
- **Beat jump** — step forward or back by a set number of beats.

## DJ tab — mixer

The center mixer sits between the decks.

- **Channel fader (VOL)** — per-deck output level.
- **GAIN** — input trim; auto-gain normalizes a loaded track toward a target level.
- **EQ (HI / MID / LO)** — three-band per-deck equalization.
- **FILTER** — a single-knob low/high-pass sweep per deck.
- **Crossfader** — blends between Deck A and Deck B; the curve is adjustable.
- **Key lock** — keeps pitch constant when you change tempo.
- **Cue / headphone output** — pre-listen a deck on a separate output device (set via the device menu).

## DJ tab — stems, sampler, sets

- **Live stems on deck** — a loaded track can be split into stems (drums/bass/vocals/other) with a fader per stem, so you can drop parts in and out during playback.
- **Sampler bank** — pads loaded with one-shot sounds from the library; press a pad to retrigger it.
- **Setlists (Sets)** — named lists of tracks for a session. A set can be pushed to the VJ tab so visuals follow the same track order.
- **Play-next lane** — a staging area above the browser to queue tracks and assign them to a deck.
- **Key matching** — each track shows its musical key in Camelot notation to guide harmonic transitions.
- **Automix** — plays a setlist hands-free with beat-matched crossfades between tracks.

## DJ tab — MIDI control

- **MIDI-learn** — bind a hardware controller's knobs, faders, and pads to deck, mixer, and hotcue actions. Enter learn mode, move a control, then trigger the on-screen action to map it.
- **Controller recognition** — theDAW can auto-detect a connected controller by name and apply a matching template, learn any rig by capturing its controls, or infer a layout from a product photo.

## Layout editing (DJ and other surfaces)

The DJ surface (and other control surfaces) can be rearranged in a design mode:
drag controls into your own layout, add custom controls bound to engine
parameters, resize and align panels, and the layout saves per surface. Controls
fill their cells; right-click a control or panel for actions (shape, mirror,
match-size, flow, split, fill) with keyboard shortcuts.

## Library & genealogy

The Library stores generated, imported, and recorded tracks with metadata. The
genealogy (lineage) views show how tracks descend from their sources — which
generation spawned which chimera, stems, or MIDI.

### Genealogy (2D)

- Tracks are laid out left to right in generational columns; each generation has a subtle background band so the columns read as distinct zones.
- **Hover** a node to light its entire ancestry and descendant chain at once.
- **Click** a node to open the inspector.
- Drag to pan; the mouse wheel zooms toward the cursor.

### Node inspector

Clicking a node opens a panel with that track's full generation parameters
(prompt, model, steps, CFG, seed), chimera sources, musical analysis (BPM, key,
loudness, pitch), tags, and rating. It also computes lineage insights —
ancestor/descendant counts, what the node spawned, and recurring prompt terms
and tags across its lineage. Copy buttons export the full record, the prompt, or
the chimera list.

### 3D graph

The 3D tab renders the whole library as a force-directed graph with selectable
node shapes, render presets, and physics. Navigation:

- **Orbit** — click-drag to rotate, wheel to zoom.
- **Fly** — WASD / arrow keys move the camera; hold to accelerate and release to coast to a stop. Q/E move up and down; hold Shift for an afterburner.
- **FTL warp** — hold F to warp quickly across the graph (a single tap gives a strong boost), shown with a star-streak and an edge motion-blur.
- **Home** — the Home button warps the camera back to frame the cluster; a "Return to cluster" button appears when you have flown out of sight.
