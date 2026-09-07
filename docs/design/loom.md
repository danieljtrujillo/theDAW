# LOOM — shards, the beat clock, and a Jacquard for your own catalogue

Status: design + phase 0 implementation, 2026-09-06. Owner: the LOOM tab.

## The ask

> Use all the audio analysis we have to intelligently tear our tracks apart and
> reassemble them beatmatched, syncopated, harmonized. Store the analyzed
> components so comparison finds unique pairings. Use pieces of songs as samples
> in NodeF.I., Sway, Perform and DJ — always quantized, faster and more
> automated than pressing a sample trigger. Make the granular bleed in EDIT
> quick enough to do on the fly. Start live-coding, with a port/variation of
> Keijiro Takahashi's Jacquard.

## What we already have (verified 2026-09-06)

| Capability | Where | Persisted |
| --- | --- | --- |
| BPM + full beat-times array | `analysis.beats_json` (aubio, librosa fallback) | SQLite |
| Downbeat phase, fitted grid, per-bar rms / low_frac / onset density / centroid / chroma[12] / mfcc[13], phrases with section labels, LUFS | `backend/modules/chimera/{structure,analysis,tempo}.py` | `data/cache/chimera/<sha>.json` |
| Key / scale / confidence, Camelot solver | `analysis/key.py`, `chimera/harmony.py`, `lib/camelot.ts` | SQLite |
| Stems 2 / 4 / 6 / 12 (LARSNET drum split) | `backend/modules/stems` | WAV + `stems` rows |
| MIDI, drum onsets → GM hits, chord track per beat, lyrics per word | `midi/`, `midi/drums.py`, `notation/exporters/chordtrack.py`, `lyrics/` | files + `notation_artifacts` |
| Onset slicing with loudness / brightness / salience | `lib/audioAnalysis.ts`, `lib/morphCorpus.ts` | browser memory |
| Granular identity bleed (Metamorph) | `granular-morph.worklet.js`, `state/morphEngine.ts` | — |
| Signalsmith time-stretch worklet (DJ keylock) | `state/djEngine.ts` | — |
| One shared `AudioContext` for every surface | `state/playerStore.ts` | — |
| The only launch quantizer: PERFORM, bars only, component-local | `DawSessionGrid.tsx:427` | — |

What we do not have: a shared beat clock (five unrelated BPM owners), any
beat-aligned slicing (onsets only), any store of fragments, quantized sampler
pads, and any live-coding surface (no code editor, no DSL, no `eval`).

## The idea in one paragraph

Every song in the library is torn into **shards**: one-bar (and one-beat, two-
and four-bar) fragments of each stem, cut on the song's own downbeats, each
carrying the descriptors we already compute. Shards live in the library
database as the **Shard Index**, queryable by role, key compatibility, tempo
ratio, energy, section, rhythm mask and text. One **Beat Clock** on the shared
AudioContext gives every surface the same bar and beat phase. A **Shard
Engine** launches any shard (or any *query*, resolved at launch) on the next
grid line, tempo-conformed to the clock and pitch-corrected to the key. On top
sits **LOOM**, a tile sequencer that is Jacquard with one substitution: a tile
is not an FM note, it is a shard query. Stacks, gates, locks, jumps, per-lane
step lengths and the master-lane sync boundary are kept exactly. The score is
plain text, and that text is the live-coding surface. Shards are also exposed
to DJ pads, PERFORM slots, NodeF.I. nodes and Sway punches, all through the
same engine, so a pad press is a quantized, beat-matched, key-matched launch.

## 1. Shard Index (backend)

`backend/modules/shards/` — migration `SCHEMA_VERSION = 6`.

```text
shards
  id TEXT PK            -- "<entry_id>__<stem>__<bar>x<beats>"
  entry_id, stem_name   -- 'mix' when no stems exist
  role                  -- drums|kick|snare|hihat|cymbals|toms|bass|vocals|guitar|piano|other|mix
  start_sec, end_sec, beats INT, bar_index INT
  bpm REAL              -- the song's bpm at extraction (from analysis)
  key, scale, camelot   -- song level
  pc_root INT           -- per-shard chroma argmax (0..11), -1 when flat
  rms_db, low_frac, onset_density, centroid_hz
  onset_mask INT        -- 16-bit: which 16ths inside the shard carry an onset
  energy REAL           -- rms percentile within the song (0..1)
  section               -- intro|build|peak|body|outro|'' (chimera phrases)
  chord                 -- symbol from the chord track when present
  words                 -- lyric words inside the window when present
  chroma_json, mfcc_json
  version INT
shard_pairings
  a_id, b_id, weight REAL, kept_at   -- the user's kept combinations (taste memory)
```

Extraction `ensure_shards(entry_id)` runs through `backend/core/pipeline.py`
like stems/midi/lyrics (`run_once` de-dupes, GPU lane not needed). It needs the
`analysis` row (beats). It reads every `stems` row, else the mix; folds the beat
list onto downbeats (chimera `estimate_downbeat_phase`); cuts 1-bar shards, plus
1-beat sub-shards for percussive roles and 2/4-bar aggregates; one STFT per
stem gives the per-shard descriptors (reuse `chimera/structure.beat_features`);
`onset_mask` comes from `librosa.onset.onset_detect` folded to 16ths; `chord`
and `words` are joined from the chord track and lyrics doc when they exist.
Settings: `shards.auto_on_import` (default true, cheap), `shards.after_stems`
(re-run when stems land — the mix shards are replaced by stem shards).

Routes:

- `GET  /api/shards/{entry_id}` — the entry's shards.
- `POST /api/shards/query` — `{role?, beats?, camelot_of?: entry_id|key, bpm?: number, stretch_max?: 0.12, energy?: [lo,hi], section?, exclude_entry?, mask_like?: int, text?, limit}` → ranked shards. Ranking = weighted sum of key distance (Camelot), tempo feasibility (`|log2(bpm/shard.bpm)|` after octave folding), energy match, mask similarity, novelty (fewer prior pairings).
- `POST /api/shards/pairings` — `{shard_id}` or `{entry_a, entry_b}` → complements: harmonic compat, spectral complement (`low_frac`, `centroid_hz` non-overlap), rhythmic complement (`popcount(a & b)` low, `popcount(a | b)` high = syncopation potential), energy match, novelty.
- `POST /api/shards/keep` — `{a_id, b_id}` bumps `shard_pairings.weight`.
- `GET  /api/shards/{id}/audio?bpm=&semitones=` — a WAV crop of the stem. With `bpm`/`semitones` the server conforms (librosa `time_stretch` / `pitch_shift`) and caches under `data/cache/shards/`; the client uses this path only when the ratio exceeds what `playbackRate` + Signalsmith can do cleanly (`> ±12 %`).

## 2. Beat Clock (frontend, shared)

`frontend/src/lib/beatClock.ts`. One transport on `getEngineCtx()`:

- `bpm`, `beatsPerBar`, `anchor` (ctx time of bar 0). `setBpm()` re-anchors at
  the current beat so phase is preserved. `setSource()` follows DJ deck A/B
  (its `beatgrid` + rate), PERFORM `project.tempo`, EDIT `bpm`, or NodeF.I.
  Live Out; the surface that is *playing* is the master, the others follow.
- `nextGrid(grid: 'bar'|'2bar'|'4bar'|'beat'|'half'|'8th'|'16th'|'now', from?)`
  returns a ctx time. `phase()` → `{bar, beat, sixteenth, frac}`.
- A 25 ms lookahead ticker (`arpEngine` pattern) emits `onBar` / `onBeat` with
  the *scheduled* time, 120 ms ahead, for sequencers.
- PERFORM's `nextLaunchTime` delegates here (gains beat/16th options and a
  phase that survives a stop). DJ SYNC sets the clock from the master deck.
  NodeF.I. Live Out `bpm` binds to it. EDIT tap tempo writes it.

## 3. Shard Engine (frontend, shared)

`frontend/src/lib/shardEngine.ts` + `state/shardIndexStore.ts`.

- The store mirrors the index for the songs on deck (`/api/shards/{entry}`),
  so a query resolves in memory in under a millisecond; misses fall back to
  `/api/shards/query`.
- `launch(target, opts)` where `target` is a shard id or a query, `opts` =
  `{ at: grid, bars?, gain?, transpose?: 'key'|semitones, lane?, choke? }`.
  Buffers are decoded once and LRU-cached (blob → `AudioBuffer`). Playback rate
  = `clock.bpm / shard.bpm` folded into `[1/√2, √2]`; when `transpose` is set,
  or keylock is on, a Signalsmith stretch worklet (factored out of `djEngine`
  into `lib/stretchWorklet.ts`) corrects pitch by `-12·log2(rate) + semitones`.
  Loops to fill `bars`. Each lane is a `GainNode → rack FX chain → loom bus →
  master`, so lanes can carry any of the 19 rack effects.
- Voice pool of 24 shared across lanes; a new voice steals the quietest, and a
  voice quieter than everything sounding is dropped (Jacquard's rule).
- `bleedTo(voice, nextShard, seconds)` hands the running voice and the incoming
  shard to the Metamorph worklet for a granular seam instead of a cut. This is
  the "granular bleed on the fly" as an engine primitive; the EDIT context-menu
  action is the same operation offline.

## 4. LOOM — the Jacquard variation

New centre tab **LOOM** (`views/LoomView.tsx`, `state/loomStore.ts`,
`lib/loomEngine.ts`).

Kept from Jacquard verbatim:

- Lanes are rows of steps, time runs left to right; **step length per lane**
  (1/1 … 1/64, sixteenth default) and **lane length** in steps → polyrhythm.
- **Stacks** read top to bottom at one instant; **gates stop the descent**
  (everything below is skipped); **locks colour what is read after them** —
  the tiles below in the stack and the lanes below while the step lasts.
- Tiles: Channel Start (lane head, with Play / step length / lane steps),
  Lane End, Jump, Jump Target (one Jump per target; a Jump on the rail row is
  unconditional), Cycle Gate (period 2–32 with a switch per lap), Chance Gate
  (percentage), Absolute Lock, Relative Lock.
- The **master lane** (first lane of channel 1) is the sync boundary: queued
  score changes — including a new text score from the code pane — apply when
  the master lane loops.
- Twenty-four shared voices, quietest-steal.

Substituted:

- The **Note tile** becomes the **Shard tile**: `{ query | shardId, lengthSteps,
  gain, transpose }`. A stack of shard tiles is a *pairing* — kick from one
  song, bass from another, a vocal word from a third — and a kept stack posts
  to `/api/shards/keep`. Shard tiles carry an optional `roll` (re-resolve the
  query every lap / every N laps / never) so a lane can stay "a drum bar from
  anything in 8A at this energy" and change material on its own.
- Lockable parameters (15, as Jacquard): `gain`, `pan`, `transpose`,
  `stretch` (0 = playbackRate only, 1 = full Signalsmith), `bleed` (seam
  length in steps), `cutoff`, `resonance`, `drive`, `crush`, `delay_send`,
  `reverb_send`, `gate_ratio`, `attack`, `release`, `roll`.
- The sound engine is the Shard Engine + rack FX per lane. A `bleed` lock
  above a shard tile makes the transition into it granular.

The score is a plain text file (`.loom`) and that file is the live-coding pane.

## 5. Loom notation (live coding)

Two views of one score: the tile grid and the text. Editing either updates
the other; a text edit that parses is queued to the master loop wrap (as
Jacquard queues score switches), a text edit that does not parse shows the
error inline and leaves the running score alone.

The text IS the plane. A lane block is a header followed by rows of one token
per step; the LAST row is the rail (where shards usually sit) and the rows
above are the upper stack, read top→bottom. Grammar (v1, as implemented in
`frontend/src/lib/loomScore.ts`):

```text
bpm 128            ; follows the beat clock when omitted
key Am             ; transposition target; 'follow' = the first crate song's key

lane drums 1/16 x16              ; name, step length, lane steps
  .   .   ?60 .   .   .   !2:4 .   | .   =gain-6,cut.35 .  .   .   .   +trans12 ->fill
  k   .   h   .   s   .   <eacc:drums> . | k .            h  k   s   .   h        .

lane bass 1/8 x8
  b   -   -   b   .   b   -   -    ; '-' extends the previous shard (rail only)

lane fill 1/16 x4 @target        ; a Jump Target lane (branch), not a channel
  k   k   k   k
```

Tokens: `.` / `~` empty · `-` tie (rail row) · `k s h c t d` drum roles ·
`b v g p o m` bass / vocals / guitar / piano / other / mix · `<song:role>` pin
a song, `<song:role#12>` its bar 12, `<#shardId>` one shard ·
`{role=drums energy>0.7 entry!=eacc text=love}` query literal · suffixes `:N`
length in steps (also written by the serializer where a tie cannot carry it),
`^` re-roll every lap, `^N` every N laps · `?60` chance gate · `!2:4` cycle
gate (lap 2 of 4; `!1,3:4`) · `=gain-6,cut.35` absolute lock · `+trans12`
relative lock · `->name` jump · `@target` on the lane header · `;` comment.
Lock names: gain pan trans stretch bleed cut res drive crush dly rev gate att
rel roll. Step subdivision (`[k k]`) is not in v1; use a finer lane step.

Everything the assistant can do with `editor_*` tools it gets for LOOM too
(`loom_set_score`, `loom_query`, `loom_keep`): "a syncopated drum lane from
EACC under the Prologue vocal, in key" is one tool call.

## 6. Every surface gets shards

| Surface | What changes | Why it is faster than a sample trigger |
| --- | --- | --- |
| **DJ** | sampler pads gain a *shard mode*: a pad holds a query, not a file; press = `launch(query, {at:'beat'})` on the master deck's clock; pads join the MIDI action map (they are mouse-only today) | the pad never needs loading, never needs beatmatching, never plays off-grid |
| **PERFORM** | a clip slot can hold `shard:` content that re-resolves each launch; the grid's quantizer delegates to the Beat Clock | scene launch pulls fresh, in-key, in-tempo material every lap |
| **NodeF.I.** | a `shard` live node (Stem node with a query and a `roll` input); Live Out BPM binds to the Beat Clock | a beat-synced LFO edge re-rolls material with zero clicks |
| **Sway** | dims modulate lane locks (`gain`, `cutoff`, `bleed`) through the existing `fx` CcMod path; pads punch momentary shard tiles | hands change *which* material plays, not just how loud |
| **EDIT** | "Bleed the seam" / "Bleed into this clip" on the clip menu (shipped 2026-09-06); "Weave from selection" sends selected clips into the index as ad-hoc shards; a LOOM score can be printed onto tracks as clips | the offline and live bleed are one operation |

## 7. Phasing

- **Phase 0 — this session.** Design (this doc). EDIT bleed quick action.
  Ableton device-FX routing into PERFORM chains (was the blocker for Sway
  sets). Beat Clock. Shard Index (schema, extraction, query, pairings, audio
  crop). Shard Engine. LOOM tab v1: grid + notation parser + playback with
  gates, locks, jumps, master-lane sync; registered in the tab bar and the
  assistant's navigate aliases.
- **Phase 1.** DJ shard pads + MIDI pad actions. PERFORM shard slots and clock
  delegation. NodeF.I. `shard` node. Weave → EDIT clips.
- **Phase 2.** Pairing intelligence with taste weights; server-side conform
  cache; bleed as a lane transition; Sway dims → locks; assistant `loom_*`
  tools; `.loom` inside `.tasmo`.
- **Phase 3.** Learned embeddings (CLAP/MERT) for the similarity term once one
  is in the tree; word-level vocal shards from the lyrics doc as a `v` role
  with text search.

## 8. Deliberately not doing

- A learned embedding now — nothing in the tree has one; handcrafted
  descriptors we already compute (chroma, mfcc, onset mask, energy) cover the
  first two phases.
- A general-purpose code runtime (`eval`, Strudel). The notation compiles to
  the grid; nothing user-typed executes as JavaScript.
- Re-plumbing NodeF.I.'s Live Out off `ctx.destination` as part of this. It
  should join the master bus, but that is its own item.
- Fixing `backend/modules/analyzer` (its `edit_tools_backend` import is
  broken, so `/api/edit/analyzer/*` 500s). Logged in IN-THE-WORKS; the shard
  extractor does not depend on it.
