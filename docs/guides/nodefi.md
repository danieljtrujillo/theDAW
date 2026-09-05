# NodeF.I. — node graphs: AI pipelines and live performance

NodeF.I. (the tab reads **NODEFI**) is a visual node-graph
editor with two personalities on one canvas:

- **Run** executes a graph OFFLINE through the AI stack — Stable Audio
  generations, Magenta, studio effects, merges, feedback loops — and can save
  results to the library.
- **LIVE** performs a graph in REAL TIME — stems and tracks loop through live
  filters, VCAs, echoes, crossfades and the Rack FX engine (Kargyraa, Gater,
  Chop, Ring Mod, Bitcrush, Ares, The Owl…), with LFOs automating parameters
  while you play. No AI model runs in LIVE mode.

It lives on the **NODEFI** tab in the center bar, between Underfit and Learn.

## The layout

There is no toolbar row — the canvas owns the whole surface:

- **Left rail — the node foundry.** Node types as square tiles (orb + name;
  hover for the description), grouped Sources / Generate / Process / Live FX /
  Automation / Output, with a search box on top and the **Live sets** rack at
  the bottom. **Pull a tile out of its goo** to drag a new node onto the
  canvas — a gooey strand stretches from the tile until it snaps and the orb
  follows your pointer; release over the canvas to drop the node there.
  Clicking (or Enter) drops one at the canvas centre instead.
- **Right rail — the inspector.** Parameters for the selected node.
- **Both rails resize** (drag their inner edge) **and collapse** (the chevron
  at the top; a slim strip remains to expand them again). Widths and
  open/closed state persist.
- **The command dock** floats at the canvas's bottom centre: **LIVE** (when
  the graph has live nodes), **Run/Stop**, undo/redo, zoom-to-fit, reset view,
  and clear.

## The canvas

- **Pan** by dragging the background; **zoom** with the wheel (toward the
  cursor).
- **Move a node** by dragging its disc. Each disc carries its kind's glyph
  and accent color, so types read at a glance.
- **Wire nodes** by dragging from an output port (right rim) to an input port
  (left rim). Ports are typed: **audio** wires carry sound, **mod** wires
  (dashed) carry LFO automation — the editor refuses a mismatched connection.
  A non-variadic input holds one wire; dropping a new one replaces it.
- **Select** a node to edit it in the inspector; ctrl-click toggles a
  multi-selection, shift-drag marquees, dragging any selected node moves the
  whole selection. Wires are clickable (fat invisible hit path); double-click
  or Delete removes one. Right-click nodes or wires for context menus.

### Keyboard

| Key | Action |
|---|---|
| `Ctrl/Cmd + D` | Duplicate the selection (internal wires remapped) |
| `Delete` | Delete the selected nodes or wire |
| `Ctrl/Cmd + Z` / `Ctrl/Cmd + Y` | Undo / redo |
| `Ctrl/Cmd + A` | Select all |
| `F` | Zoom to fit |
| `Esc` | Clear the selection |

Shortcuts are scope-arbitrated: they fire only while the canvas has focus and
never steal keystrokes from a text field or another tab. The graph (nodes,
wires, pan/zoom, rail layout) autosaves and restores on the next launch.

## Node types

### Sources

| Node | What it does |
|---|---|
| **Library** | A library entry as the source (offline and LIVE) |
| **Stem** | One demucs stem of a library song — or its full mix — looping live; also works as an offline source. Songs without a separation offer the full mix; run stem separation in the Library to unlock the six stems. |

### Generate / Process (offline — the Run path)

| Node | What it does |
|---|---|
| **Generate** | Stable Audio generation from a prompt (optional init input) — local GPU |
| **Magenta** | Magenta RT2 generation (optional style input; needs the engine) — local GPU |
| **Suno (Cloud)** | Cloud generation through the Suno API — **no local GPU needed**. Simple (describe it) or Custom (style + lyrics + instrumental) mode; set the API key once in Settings → Models and the key stays server-side |
| **Effect** | One studio (backend) effect; the inspector shows its parameters |
| **Merge / Mix** | Sums inputs into one clip (optionally normalized) |
| **Feedback** | Loops audio back upstream a bounded number of passes |
| **Output** | Ends a branch; optionally saves to the library |

### Live FX / Automation (real time — the LIVE path)

| Node | What it does | Mod port |
|---|---|---|
| **Filter (Live)** | Resonant low/high/band/notch filter | frequency |
| **VCA (Live)** | Gain — gate, duck, pump | gain |
| **Echo (Live)** | Feedback echo | mix (throws) |
| **Crossfade (Live)** | Morph between two inputs | position |
| **Rack FX** | ANY rack effect live: Kargyraa Sub, Gater, Chop, Ring Mod, Bitcrush, Ares (the .gan grain surface), The Owl spatializer, Phantom Bass, compressor/EQ/reverb/delay and more | the param named in **Mod target param** |
| **LFO** | Automation source — sine/triangle/square/saw, free-Hz or beat-synced (1/16 … 4 bars) with a depth in the target's units | — (it IS the mod source) |
| **Live Out** | The live master. Its **BPM** drives every synced LFO | — |

Live-only nodes refuse to Run offline (the node errors with "press LIVE");
the Stem node is the one dual citizen.

## LIVE mode

Press **LIVE** in the dock. Sources decode, then everything starts on the
same clock edge so stems stay phase-locked. While live:

- **Every inspector knob is hot** — filter sweeps, echo times, LFO rates,
  rack params stream into the running audio, smoothed.
- **LFO → Live FX** mod wires modulate at audio rate; **LFO → Rack FX** wires
  modulate at control rate: the LFO drives whichever param key you name in
  the Rack FX node's **Mod target param** field, clamped to that param's
  range.
- Changing the Live Out **BPM** re-rates every synced LFO on the fly.
- **Structural edits** (adding/removing nodes, rewiring) stop the performance
  cleanly — re-press LIVE to re-arm. Param edits never interrupt it.
- Run and LIVE are mutually exclusive.

## Live sets (templates)

The rail's **Live sets** rack holds one ready-made rig per GANTASMO song —
titled by the song, nothing else: **Will I Dream**, **EACC**, **Just Give
Up**, **Gravy**, **18301208**, **I'd Buy That For A Dollar**, **Renegade**.
Each is a different architecture (stem racks, parallel lanes, crossfaded
splits, scanner bands) built on Live FX + Rack FX + LFO automation. Loading a
set replaces the canvas — **Ctrl+Z brings your graph back**. Sets resolve
their song against the library by id, then by title; a song that is not in
the library yet shows an amber badge and loads with its source nodes unset
(import the song and reload the set).

## Saving your own sets

The rail's **My sets** section saves the current canvas under a name (Enter
or the Save button), lists your saved sets, and loads one back with a click —
fresh node ids are minted on load and one Ctrl+Z restores the previous graph.
Each row can be **exported to a `.nodefi.json` file** (the download icon) and
**Import set…** brings a file back in, so rigs can be backed up or moved
between machines. Sets persist per browser profile.

## Running a graph (offline)

Press **Run**. The graph executes in dependency order: each node shows
queued → running → done (or error), and a **preview** button appears on any
node that produced audio. Errors are isolated to their branch. **Stop**
cancels. Generate uses the same backend jobs as MAKE, Effect the same studio
processing as MIX, and a saved Output lands in the library like any other
generation.

### Feedback loops

A **Feedback** node lets audio loop back into an upstream input (typically a
Generate node's init) a bounded number of **iterations**. Only the sub-graph
downstream of the feedback re-runs each pass. A cycle that does not pass
through a Feedback node is rejected.

## Tips

- Confirm a chain with something small first: **Stem → Rack FX → Live Out**
  and press LIVE, or **Library → Effect → Output** and press Run.
- Pick a Rack FX effect first, then tune — the inspector swaps to that
  effect's own parameters (each label shows the param's key, which is what
  the **Mod target param** field expects).
- Turn **Save to library** off on Output nodes while auditioning offline
  graphs.
