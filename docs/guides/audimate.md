# Audimate — node-graph pipelines

Audimate is a visual node-graph editor for building and running long,
repetitive generation pipelines as a wired graph. Instead of generating a clip,
processing it, and feeding it back by hand, you lay the steps out as nodes,
connect their outputs to the next node's inputs, and press **Run** once.

It lives on the **Audimate** tab in the center bar (the connected-dots icon,
between Underfit and Learn).

## The canvas

- **Pan** by dragging the empty background.
- **Zoom** with the mouse wheel (it zooms toward the cursor).
- **Add a node** by clicking it in the left palette; it drops in the middle of
  the view.
- **Move a node** by dragging its title bar.
- **Wire nodes** by dragging from an output port (right edge of a card) to an
  input port (left edge of another card). A dashed wire follows the cursor;
  release over an input to connect. A non-variadic input holds one wire, so
  dropping a new wire there replaces the old one.
- **Select a node** to edit its parameters in the right inspector; the trash
  icon there (or the toolbar trash) deletes.
- **Select many** with ctrl-click to toggle nodes in and out of the selection,
  or shift-drag on empty background for a marquee. Dragging any selected node
  moves the whole selection.
- **Select and delete wires.** Wires are clickable (they carry a fat invisible
  hit path, so you do not have to be precise); double-click one or press Delete
  with it selected to remove it.
- **Context menus** — right-click a node or a wire for its actions.
- **Reset view** re-centers; **Clear** empties the graph.

### Keyboard

| Key | Action |
|---|---|
| `Ctrl/Cmd + D` | Duplicate the selection (wires between duplicated nodes are remapped) |
| `Delete` | Delete the selected nodes or wire |
| `Ctrl/Cmd + Z` / `Ctrl/Cmd + Y` | Undo / redo |
| `Ctrl/Cmd + A` | Select all |
| `F` | Zoom to fit (also on the toolbar) |
| `Esc` | Clear the selection |

Keyboard scope is arbitrated, so these shortcuts only fire while the canvas has
focus and never steal a keystroke from a text field or another tab.

The graph (nodes, wires, and pan/zoom) is saved automatically and restored on
the next launch.

## Node types

| Node | What it does | In → Out |
|---|---|---|
| **Library** | Loads an existing library entry as the pipeline's source | — → audio |
| **Generate** | Runs a Stable Audio generation from a prompt (optional init audio input) | init? → audio |
| **Magenta** | Runs a Magenta RT2 generation (needs the Magenta engine running; optional style input) | style? → audio |
| **Effect** | Runs one studio effect on its input; the inspector shows that effect's own parameters | audio → audio |
| **Merge / Mix** | Sums several inputs into one clip (optionally normalized) | many → audio |
| **Feedback** | Loops its input back to an upstream node a bounded number of times | audio → audio |
| **Output** | Ends a branch; optionally saves the result to the library | audio → — |

Each port is typed (audio); the editor only lets you connect compatible ports.

## Running a graph

Press **Run**. The graph executes in dependency order: each node shows
**queued → running → done** (or **error**), and a small **preview** button
appears on a node once it has produced audio, so you can listen to any stage.
Errors are isolated to their branch — one failed node does not stop unrelated
branches. **Stop** cancels an in-progress run. Run activity is also written to
the LOG panel.

Nodes reuse the app's existing job infrastructure, so a Generate node runs the
same backend generation as the MAKE tab, an Effect node runs the same studio
processing as MIX, and a saved Output appears in the library just like any other
generation.

## Feedback loops

A **Feedback** node lets an output loop back into an upstream input (typically a
Generate node's init input) with a bounded **iterations** count. On each pass the
loop feeds the previous pass's audio back in, so "generate → effect → feed back →
regenerate" runs the set number of times and then stops. Only the part of the
graph downstream of a feedback node re-runs each pass; everything else runs once.
A cycle that does not pass through a Feedback node is rejected as invalid.

## Tips

- Start simple: **Library → Effect → Output**, or **Generate → Output**, to
  confirm a chain before adding branches.
- The Effect node's parameters change with the chosen effect — pick the effect
  first, then tune its numbers.
- Turn **Save to library** off on an Output node while you are still auditioning,
  so you do not fill the library with drafts.
