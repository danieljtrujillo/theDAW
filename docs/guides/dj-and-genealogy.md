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
- **Prepared performance sets** — a set folder dropped into `data/performance-sets/<Set>/` with the audio files and a `performance.json` timeline (as written by Z-AutoDJ, or by hand) appears under Sets on startup. Each track can carry a cue-in point, a mix-out point and a transition length; automix follows them instead of its fixed distance-from-end rule, so a set plays exactly as it was prepared. The audio files are registered in the library in place, so the decks, analysis and stems treat them like any other track.
- **Assistant control mid-show** — the assistant orb can steer a running set: ask what is on (active set, now playing, running order), make a set active, start or stop automix, blend into the next track now, or move a named track to play next. The set keeps playing itself between instructions.

## DJ tab — starting a set

**START AUTO DJ** sits in the DJ header above the decks and is the one-click way
in. It is never a disabled `<button>`: a disabled control loses its tooltip and
its place in tab order, so the reason would never reach you. Instead it marks
itself `aria-disabled` in the two states where the press cannot change anything,
and the tooltip says what is missing. The accessible name a screen reader
announces carries the same reason in its own wording, because a screen reader
reads the name and generally drops the tooltip.

- No sets at all — tooltip "Create a set first — click to make one", name "Create a set".
  This press is a real action: it makes the set it is asking for, so it is not
  marked `aria-disabled`.
- Sets exist but none is active — tooltip "Pick a set below", name "Start Auto DJ — pick a
  set below first".
- The active set has fewer than two playable tracks — tooltip "Add at least 2 tracks to this
  set", name "Start Auto DJ — add at least 2 tracks to this set first".

Once a mix is running the button reads **STOP AUTO DJ**. Stopping ends the
sequencer only: whatever is on the decks keeps playing.

A set that came from a prepared `performance-sets` folder counts its
not-yet-registered tracks toward those two, because opening or starting the set
is what registers them.

**The Sets rows** in the Source Tree carry the same controls:

- The row name opens the set. While its tracks are being registered the row
  shows a spinner and both of its buttons stand down.
- An **ACTIVE** badge marks the set automix actually reads — after a Send to DJ
  that is not necessarily the set you last opened.
- The **▶** on the right auto-DJs that set: load, beatmatch and crossfade the
  whole thing hands-free. It is dimmed while a registration is in flight, or
  when the set has fewer than two tracks.
- The small number is the track count.

**The 1-2-3 hint** floats over the decks while nothing is loaded and nothing is
mixing — pick a set on the left, press START AUTO DJ above the decks, or drag a
track straight onto a deck. It is a caption, not a wizard: it takes no clicks
and disappears the moment a deck holds a track.

**If the first deck never loads**, automix gives up after 15 seconds with
"Automix: Deck A never finished loading" and switches itself off, rather than
ticking over silence.

## DJ tab — what automix does during a blend

- **Phrase-aligned start.** The mix-out point is quantised DOWN to a 16-beat
  phrase line of the outgoing track — a real detected downbeat when the rhythm
  cache has one, otherwise the beatgrid. Quantising only ever moves the blend
  earlier, never later.
- **Where the blend is due.** A prepared set's own mix-out point when it has
  one, otherwise 18 seconds before the end. Never before half the track has
  played, so a track shorter than about 18 seconds blends out from its midpoint
  instead of from its first frame.
- **The first track starts on its first beat.** The seed waits up to 3 seconds
  for the tempo to land, then seeks to the first beat and plays. If analysis has
  not landed by then it starts anyway and says so — "Automix: starting before
  analysis landed — first mix may be unmatched" — because dead air is worse than
  an unmatched first bar.
- **Bass swap.** Two basslines at once is the sound of an amateur automix. The
  outgoing low band is handed over to the incoming one across the middle third
  of the fade (down to −26 dB relative to your own EQ setting), flat for the
  first third and settled for the last.
- **Phase bend.** The follower is pulled into phase by bending the platter, not
  by seeking — a seek right after play is an audible restart. A correction the
  bend cannot deliver in one window is carried over to the next tick; anything
  inside 8 ms is left alone rather than chased forever.
- **Sync-lock is held for the whole blend.** Matching tempo and phase once is
  not enough: two tracks at slightly different real tempos drift apart audibly
  over a ten-second fade, so the lock stays on until the fade lands and is
  released with it.
- **Key-lock** engages on the follower whenever the beatmatch needed more than
  about 3 % of pitch — past that, a pitched "harmonic" pair audibly is not one.
- **Honest messages.** The tempo match never claims more than it did:
  - `BPM Sync: Deck B follows Deck A at 128.0 BPM` — matched (with
    "(half/double time)" when the match came from folding an octave).
  - `Deck B: 128.0 BPM needs more than ±10% — NOT beatmatched` — the pitch fader
    cannot reach that tempo at the selected range. The deck is left at 0 %
    rather than parked at the rail, and it gets no key-lock and no phase nudge:
    a deck at the limit is no closer to the master's tempo than one at zero.
  - `Automix: mixing unmatched → Deck B (incoming BPM unknown)` — the blend went
    ahead without a beatmatch. The reason in brackets is one of "incoming BPM
    unknown", "outgoing BPM unknown", or "BPM out of the ±10% range".
  - `Automix: blending → Deck B, on the phrase` — matched, and the blend started
    on a phrase line.
- **No dead air.** A deck that has played and then run out is rescued with a
  one-second crossfade into the next track instead of the full fade. A deck that
  has never made a sound — still decoding, or still loading — is waited for, not
  treated as a finished track; before this, a set could churn through a track
  every few seconds and never play any of them.
- **Harmonic next track.** With at least three tracks still to come and a key
  clash straight ahead, automix skips to the nearest Camelot-compatible track.
  Strict set order otherwise, and a track nobody has analysed is never skipped
  over — an unknown key is not a known clash.

## DJ tab — hot cues and downbeats

- **Seeded hot cues.** When a track's analysis lands, its four pads are filled
  in the way a DJ places them by hand: cue 1 on the first downbeat (the first
  beat when no downbeats are known), then the starts of the 16, 32 and 48-bar
  phrases after it. The markers show on the waveform too.
- **Your cues are never overwritten.** Once you have set or cleared a cue on a
  track, the seeder leaves that track alone for good; only cues it placed itself
  can be moved by a later, better seed.
- **Short tracks get fewer.** A phrase that falls past the end of the file
  leaves its pad empty rather than being clamped to the end — otherwise two or
  three pads land on the same spot.
- **Where downbeats come from.** The DJ tab reads the rhythm module's cache and
  never starts a run of its own: a deck load asks `GET /api/rhythm/{id}` once and
  falls back to plain beats when the cache has nothing. Run the **Rhythm**
  analysis on a track (from TrackInfo or the Rhythm block) and the DJ tab picks
  up real bar lines on the next deck load — a miss is only remembered for 30
  seconds. Those downbeats drive three things: the bar lines on the beatgrid
  (instead of assuming every fourth beat), the cue seeding above, and the phrase
  alignment automix blends on.

## DJ tab — MIDI control

- **MIDI-learn** — bind a hardware controller's knobs, faders, and pads to deck, mixer, and hotcue actions. Enter learn mode, move a control, then trigger the on-screen action to map it.
- **Controller recognition** — theDAW can auto-detect a connected controller by name and apply a matching template, learn any rig by capturing its controls, or infer a layout from a product photo.

## Layout editing (DJ, MIX, TRAIN)

The DJ, MIX, and TRAIN tabs run on the same Control-Surface editor. Click
**Edit Layout** (top-right) to enter design mode: drag panels and controls into
your own arrangement, add custom controls bound to engine parameters, resize and
align panels, and the layout saves per surface. Controls fill their cells;
right-click a control or panel for actions (shape, mirror, match-size, flow,
split, fill) with keyboard shortcuts.

On MIX, the top two rows are input/output visualizations (toggle waveform / live
scope, with an A/B overlay-compare), the middle is the effect workflow (effect
rail + Quick Master, the effect library, and the active chain), and the lower
region is the effect stage. On TRAIN, the LoRA-config, datasource, autoencoder
bench, telemetry, and console sections are each a rearrangeable panel.

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
