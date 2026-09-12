# LOOM and the Shard Index

LOOM is the thirteenth workspace tab. It plays your own catalogue back to you as
a colony of living cells: every song in the library is cut into **shards** —
beat-aligned fragments of each stem — and a colony is a graph of cells that pull
shards out of that index, tempo-matched and key-matched, on the grid.

Two things make it work, and both are useful on their own:

- the **Shard Index** (`backend/modules/shards`), a searchable store of every
  fragment of every analysed song, with the descriptors already computed for it;
- the **Beat Clock** (`frontend/src/lib/beatClock.ts`), one bar-and-beat phase
  on the shared AudioContext that LOOM, the DJ shard pads, PERFORM slots and
  NodeF.I. all read, so "next bar" means the same thing everywhere.

The design document behind all of this is [docs/design/loom.md](../design/loom.md).

## The Shard Index

A **shard** is one fragment of one stem of one song, cut on that song's own
downbeats. Each carries what the library already knew about that moment:

| Field | What it is |
|---|---|
| `role` | `drums`, `kick`, `snare`, `hihat`, `cymbals`, `toms`, `bass`, `vocals`, `guitar`, `piano`, `other`, or `mix` when the song has no stems |
| `beats`, `bar_index` | Length in beats (1, 2, 4, 8 or 16) and which bar of the song it came from |
| `bpm`, `key`, `scale`, `camelot` | The song's tempo and key at extraction — what makes conforming possible |
| `pc_root` | The shard's own chroma argmax (0–11), or −1 when it is flat |
| `rms_db`, `low_frac`, `onset_density`, `centroid_hz` | Loudness, low-end share, how busy it is, how bright |
| `onset_mask` | 16 bits: which sixteenths inside the shard carry an onset. This is what "sounds like this rhythm" searches on |
| `energy` | The shard's RMS percentile *within its own song*, 0–1, so a quiet song's loud bar still reads as loud |
| `section` | `intro`, `build`, `peak`, `body` or `outro`, from the chimera phrase analysis |
| `chord`, `words` | The chord symbol and the lyric words inside that window, when a chord track or aligned lyrics exist |

Sharding needs the song's `analysis` row (the beat times). It runs through the
same pipeline coordinator as stems, MIDI and lyrics, so it de-dupes and never
fights the GPU lane. A song that has never been sharded is cut on first
reference, and anything asking for it sees status `sharding` until the rows
land.

Stems matter here. A song with no stems is sharded from its mix and every shard
has role `mix`; once stems exist, the mix shards are replaced by per-stem ones,
which is what makes "give me a kick from anywhere" possible.

### Conforming

The index stores crops, not renders. `GET /api/shards/{shard_id}/audio` cuts the
WAV on demand, and two query parameters conform it on the way out: `?bpm=` time-
stretches the crop to the asked-for tempo, and `?semitones=` transposes it. A
ranked query also returns a `transpose` per row when you gave it a target key,
so the caller knows what to ask for. Results are cached under
`data/cache/shards`.

### Taste memory

`POST /api/shards/keep` records that you kept a pairing of two shards. It bumps
a weight in `shard_pairings`, and the ranker reads those counts back as a
**novelty** term — a combination you have already used scores lower, so the
index keeps offering you something you have not heard. It is the only part of
the ranking that learns.

## The colony

Open the **LOOM** tab. The left two-thirds is the dish; the right is a pane
switcher with **CELL**, **CODE** and **CRATE**.

### The crate

CRATE is where songs go in. Pick one from the dropdown and it is added and
sharded; the row then says how many shards it has and the song's key and tempo.
An empty crate is not an error — loops with an empty crate search the whole
index instead. Below the crate is a browser: pick a song and a stem, and every
one-bar shard is listed with its bar number, energy, chord and lyric words.
The play button auditions one on the next beat; **pin** locks the selected loop
cell to that exact bar instead of a query.

### Cells

A colony is a graph, not a grid of lanes. Its nodes are cells, and there are
five kinds:

| Cell | What it does |
|---|---|
| **loop** | Plays a shard — a stem loop, a bar of bass, a word — for `beats`, or holds until the next trigger. Carries gain, transpose, pan, cutoff, resonance, glide and a stereo `space` mode (fixed, orbit, pingpong, random). |
| **rule** | A generator that emits a symbol per step of the colony's bar. |
| **gate** | Lets triggers through by chance (`?60`) or by lap (`!2:4`). |
| **mod** | Colours what passes through it — `=cut.3,gain-6`, `+trans12`. |
| **colony** | A whole graph as one cell, with its own meter and tempo. Colonies nest without limit, which is where the fractal comes from. |

Edges carry triggers: `pulse -> kick`, `swarm -> bass on=0`,
`pulse -> maybe -> dark -> bass`. A trigger into a colony starts its bar.

Add cells with the toolbar's **+** buttons or a right-click on the dish, wire
them by dragging from a cell's nub, and edit the selected one in the CELL pane
with buttons, chips and sliders. Nothing here needs typing.

### The generators

A **rule** cell runs one of nine generators over its alphabet of shard queries:

| Generator | What it emits |
|---|---|
| `fib` | Fibonacci word over the first two symbols; drifts one step per lap. |
| `fractal` | Self-similar sequences: `thue` (Thue–Morse), `cantor` (dust), `dragon` (curve turns), `sierpinski` (one triangle row per lap). |
| `euclid` | Euclidean rhythm — hits spread as evenly as possible across the span, rotated per lap. |
| `life` | Conway's Game of Life: rows are the alphabet, one generation per lap. `form AABA` replays sections. |
| `rand` | Seeded random pick per cell per lap; `p` is the chance a cell plays. |
| `frag` | One-beat fragments of the alphabet, shuffled and re-resolved every lap. |
| `echo` | A shard and its decaying repeats every N cells. |
| `accel` | Accelerando or ritardando: step time warps from × `from` to × `to` across the span. |
| `gliss` | Glissando: transpose sweeps from → to semitones across the span. |

### Meters

Meters are free. `meter 7/8 groups=3+2+2`, `meter 11/8 groups=3+3+3+2`,
`meter 5/4`. A colony's bar is num/den whole notes at its own tempo, and the
`groups` accent the downbeat of each group — which shapes both what you hear and
how the colony is drawn. Nested colonies can each be in a different meter.

### It grows

The colony is alive while it plays. The header's **grow** slider sets how eagerly
it buds, prunes and mutates on every bar; 0 freezes it. **max** caps the number
of cells, and **✚ grow** takes one growth step now. **BUD** on a selected cell
grows a child off it.

**grain** picks the shard length the colony reaches for when it buds — 1 beat is
chopped, 16 beats is four-bar drones. **swing** lands the odd steps of every
rule late: 50% is straight, 67% a triplet feel.

The header reads out the live state: cell count, the root meter, the current bar,
the growth generation, the key, the crate size, and — in amber — anything that is
silent and why.

### The dish

The canvas is not a diagram. Loops and colonies are raymarched gooey orbs in
their stem's colours, swelling and brightening when they fire; the cells are
creatures with a muscle phase and bonds that breathe and pass that phase down
the chain; every connection is a Verlet rope grown between two membranes that
sags, goes taut and creeps; a firing loop seeds hyphal tips that grow, branch
and fuse; the floor is a hex lattice that crystallizes outward from a fire; and
a Life rule shows its actual grid with its past generations stacked behind it.
The physics runs on a fixed 1/120 s step and nothing moves fast.

### The code pane

The colony is also plain text, and that text is the score. **CODE** shows the
whole colony; the CELL pane can show one cell's line on request. The text is the
colony — editing it and applying is the same thing as building it on the dish,
which is what makes the notation a live-coding surface rather than an export
format. The header says `code edited — apply to hear it` while the two differ,
and lists parse errors by count.

**Templates** (`frontend/src/data/loomTemplates.ts`) ship as starting points,
including a 7/8 · 11/8 · 5/4 nested-colony example.

## API

Prefix `/api/shards`.

```http
GET    /api/shards/{entry_id}         the entry's shards (empty list when not sharded)
POST   /api/shards/{entry_id}/run     (re)shard the entry now  — ?force=true
POST   /api/shards/query              ranked shards for a query
POST   /api/shards/pairings           complements for a shard, or between two entries
POST   /api/shards/keep               remember a kept pairing (taste memory)
GET    /api/shards/{shard_id}/audio   WAV crop, optionally conformed (?bpm=&semitones=)
```

`POST /query` takes `{role?, beats?, entry?, exclude_entry?, camelot_of?, key?,
scale?, bpm?, stretch_max?, energy?: [lo, hi], section?, mask_like?, text?,
limit?}` and returns `{count, camelot, shards}`. Ranking is a weighted sum of
key distance in Camelot space, tempo feasibility (`|log2(bpm / shard.bpm)|`
after octave folding, bounded by `stretch_max`), energy match, rhythm-mask
similarity against `mask_like`, and novelty from the kept-pairing counts.
`camelot_of` takes an entry id and uses that song's key; `key` + `scale` names
one directly, and also makes each result carry the `transpose` that would fit it.

`POST /pairings` works two ways. Given a `shard_id` it returns that shard plus
its ranked complements from the rest of the library. Given `entry_a` and
`entry_b` it returns the best pairs *between* two songs — which is the "what of
mine goes with what of mine" question.

`POST /keep` takes `{a_id, b_id}` and returns the new `weight`.

`GET /{shard_id}/audio` returns `audio/wav`. It reads the stem file when the
shard names one and the mix otherwise, and 404s when the source audio is no
longer on disk.

The whole module needs the library database; without it every route answers 503.

## Where else shards turn up

The Shard Index is not LOOM's private store. The same engine backs quantized
launches from the DJ pads, PERFORM slots, NodeF.I. nodes and SWAY punches, all
against the same Beat Clock — so a pad press anywhere in the app is a launch
that is already beat-matched and key-matched rather than a raw sample trigger.
