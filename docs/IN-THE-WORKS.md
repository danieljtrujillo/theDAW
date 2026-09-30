# In The Works

The running list of what we are going to do. Read this before starting work.

Distinct from [BACKLOG.md](BACKLOG.md): the backlog is the long-lived,
id-stable inventory of everything known to be wrong. **This** file is the active
queue — the things we have decided to do next, in order, with enough evidence
attached to start immediately.

## How to use this doc

- **Items leave only when done.** "Done" means the user said so, or it was
  verified — build, tests, or observed behaviour. Editing a file is not done.
- **On removal, add a line to [CHANGELOG.md](CHANGELOG.md).** Nothing is deleted
  silently.
- **Session journals do not live here.** "Implemented, awaiting verification"
  notes go straight to CHANGELOG under an *Unverified* heading, and the queue
  item stays ticked-off-pending until it is observed. (The 2026-08-26 → 08-28
  journals grew to 75% of this file and hid the queue; see "Revision notes".)
- **Every item carries a `file:line`.** An item without evidence cannot be picked
  up cold, which defeats the point of the list.
- **Effort** is XS (<2h), S (half day), M (1–3 days), L (1–2 weeks), XL (multi-week).
- **Status tags**: none = still open as written · `[partial]` = some of the
  claim landed, the rest is described · `[verify]` = code changed since the
  audit and probably fixes it; one live check retires it.
- If an item already has a permanent BACKLOG id, reference the id rather than
  restating it here.

Sources: the EDIT-tab audit, the Ableton `.als` import audit, and the tab sweep
(2026-08-26), re-checked against `main` on 2026-09-06.

---

## Revision notes (2026-09-06)

Re-check of all 75 open boxes against the code as of `bb43620`.

| Outcome | Count |
| --- | --- |
| Done, merged — remove and log in CHANGELOG | 22 |
| Probably done — one live check retires it (`[verify]`) | 5 |
| Partly landed (`[partial]`) | 6 |
| Still open as written | 42 |

Of the 42 still open, 9 were confirmed by direct code evidence this pass; the
rest were left untouched by every commit since the audit. Evidence `file:line`s
were refreshed where they had drifted. Nine days of shipped work (2026-08-29 →
09-05) appear nowhere in this file or in CHANGELOG; they are listed at the end.

---

## NOW — LOOM, shards and the beat clock (started 2026-09-06)

Design: [design/loom.md](design/loom.md). The user's brief: tear tracks apart
with the analysis we have, reassemble them beatmatched / syncopated /
harmonized, store the parts so pairings can be found, use them as quantized
samples in every performance surface, make granular bleed a one-gesture move,
and start live-coding with a Jacquard variation.

### Phase 0 — coded 2026-09-06, tsc + ruff + tests green, NOT yet seen in the running app

Everything below passes `tsc --noEmit`, `ruff check` / `format --check`,
`pytest tests/test_shards.py` (8) and `npm run test:loom`. None of it has been
driven in the live app yet; items stay here until that happens.

- [ ] **Shard Index (backend).** `backend/modules/shards/` + DB migration v6
  (`shards`, `shard_pairings`). One-bar / 2-bar / 4-bar shards per stem (or the
  mix), 1-beat sub-shards for percussive roles, one STFT per source for rms /
  low_frac / centroid / chroma / mfcc / 16-slot onset mask / energy percentile,
  chord + lyric joins, Camelot code. Routes: `GET /api/shards/{entry}`,
  `POST /{entry}/run`, `POST /query` (ranked), `POST /pairings` (complements),
  `POST /keep`, `GET /{shard}/audio?bpm=&semitones=` (crop, conform, cache).
  `pipeline.ensure_shards` waits for stems in flight and runs analysis first
  when missing; stems landing re-cuts a sharded entry; `shards.auto_on_import`
  / `auto_on_generate` default ON. — verify: import a song, watch
  `/api/shards/{id}` fill; run stems, watch it re-cut per stem. —
  `backend/modules/shards/{extract,service,router}.py`,
  `backend/core/pipeline.py`, `backend/modules/library/db.py`
- [ ] **Beat Clock.** One bpm / beatsPerBar / anchor on the shared
  AudioContext; `nextGrid('16th'|'beat'|'bar'|…)`, phase-preserving `setBpm`.
  Nothing else has been re-pointed at it yet (PERFORM's `nextLaunchTime`, DJ
  SYNC, NodeF.I. Live Out are Phase 1). — `frontend/src/lib/beatClock.ts`
- [ ] **Shard Engine.** Lanes (`input → lowpass → pan → gain → [Signalsmith] →
  bus → master`), buffer LRU keyed by (shard, bpm, semitones), 24-voice pool
  with quietest-steal / quieter-is-dropped, `releaseLane` seams. Tempo conform
  and per-shard key transposition happen server-side in the audio route;
  the lane-level `transpose` lock uses the Signalsmith worklet. Granular
  (Metamorph) seams inside the engine are Phase 2 — today a `bleed` lock is an
  equal-power overlap. — `frontend/src/lib/shardEngine.ts`,
  `frontend/src/lib/stretchWorklet.ts`
- [ ] **LOOM tab.** Registered (`loom` in `CENTER_TABS`, tab bar, HOME card,
  centre panel, assistant navigate enum + aliases weave/shards/jacquard).
  The plane: lanes with per-lane step length and length, stacks (last row =
  rail), chance and cycle gates, absolute/relative locks with cross-lane
  scope, jumps into `@target` lanes that return home, master-lane wrap applies
  a queued score. Notation parser + serializer are two-way; CODE pane applies
  on Ctrl+Enter; TILE pane edits the selected cell; CRATE pane puts songs on
  deck, shows sharding status, browses one-bar shards with audition + pin.
  Lock params live today: gain, pan, transpose, bleed, cutoff, resonance, gate,
  attack, release, roll; stretch/drive/crush/delay/reverb parse but are
  flagged "not yet live". — `frontend/src/views/LoomView.tsx`,
  `frontend/src/state/loomStore.ts`, `frontend/src/lib/{loomEngine,loomScore,loomKey}.ts`,
  `frontend/src/state/shardIndexStore.ts`
- [ ] **EDIT: granular bleed from the clip menu.** With two clips selected,
  right-click → "Bleed into this clip" (other clip = donor, this = host) or
  "Bleed the seam" when they overlap (only the overlap is rendered, placed as
  a seam clip on a new track); "Bleed live…" arms the same pair in Metamorph
  and opens the panel. — verify: two overlapping clips → seam clip appears at
  the overlap. — `frontend/src/components/audio/WaveformEditor.tsx`
  (`bleedClips`, `bleedPartnerFor`)
- [ ] **Ableton device-FX mappings route into PERFORM's live chains.**
  `autoRoutePerformFromProject` now emits `fx` CcMods for `target_kind ==
  'device'` (DryWet / On / macros / cutoff …) using a DAW→rack parameter-name
  translation (`translateDawParam`: per-effect aliases, generic aliases, label
  match, macro → wet/dry) and flattened→chain index conversion; imported
  devices also instantiate with their SOURCE parameter values instead of rack
  defaults (`translateDawParams`, with the reverb ms→s conversion). Closes the
  "108 of 110 mappings do nothing" and "parameter names never translated"
  items in the stated form. — verify: load the DNB Sway set, turn a DryWet
  knob, hear the chain. — `frontend/src/lib/dawEffectMap.ts`,
  `frontend/src/state/performRouting.ts`
- [ ] **Theme picker** previews without a scrim; twelve duotone themes added
  (`Duotone`, `Light Duotone` groups). Last v3 Tailwind form (`z-[300]`)
  removed; a tree-wide sweep found no others. — verify on Porcelain + Navy &
  Gold. — `frontend/src/components/menu/ThemeModal.tsx`, `frontend/src/lib/editThemes.ts`

### 2026-09-06 evening — from the user's full-suite pass (coded, green, awaiting a live check)

- [ ] **Magenta engine OOM'd while loading (RESOURCE_EXHAUSTED at 96 MiB).**
  Root cause: the JAX load ran while a Demucs separation held the GPU. Both
  engine bring-up paths (`/engine/start` and the on-demand start inside
  `/generate`) now take the pipeline's single GPU lane, so the load waits for
  stems / whisper / MIDI to finish and holds the card until the engine is
  ready. `/engine/status` reports `starting` with "waiting for the GPU" while
  queued, and an `error` state now carries `error_kind` (`gpu_oom`,
  `checkpoint_missing`, …) plus a one-sentence `fix`, which the Restart card
  shows instead of the raw JAX traceback. — verify: start stems, then Magenta;
  the engine should wait, then load. — `backend/modules/magenta/router.py`,
  `frontend/src/lib/magentaEngineClient.ts`
- [ ] **Stems separation surfaced as an ASGI traceback (`httpx.ReadError`).**
  The sidecar's connection dropped mid-poll (GPU contention with the Magenta
  load). Status polls now retry six times with backoff and reconnect, and the
  route turns any remaining failure into a 503 with a sentence that names the
  likely cause. — `backend/modules/stems/sidecar.py`, `backend/modules/stems/router.py`
- [ ] **LOOM plane redesigned to Jacquard's uniform squares.** Every tile is
  the same `size-11` square across every lane; lane headers sit in a fixed
  left column so step columns align; a step ruler; glyph + sub-line per tile
  (`k`/`?`/`!`/`=`/`→`), held cells show the span; live column ring; lap
  counter and master badge per lane. — `frontend/src/views/LoomView.tsx`
- [ ] **LOOM contrast on light themes.** The audit (the user's
  `_audit_contrast.mjs`) found 58/94 text failures on Porcelain: the view used
  a hard-coded dark surface under theme-remapped ink. Rebuilt on theme tokens
  (`et-ink*`, remapped `bg-black/*`, `border-white/*`); tile fills get denser
  light-theme variants (`[[data-et-light]_&]:`). Re-audit: 0 text failures on
  Midnight/Navy & Gold, 3 on Porcelain/Cocoa & Sand (fixed after the run).
  Elsewhere the audit found MAKE/EDIT/MIX/Settings clean on all six themes
  tried; LEARN has 4 light-theme failures (labels over the dark graph canvas)
  and DJ has 2 (a 7 px "BPM" tag) — see below.
- [ ] **Four sample LOOM scores** in the CODE pane's *sample* picker
  (`frontend/src/data/loomTemplates.ts`): *Just Give Up — skeleton* and *Et Tu
  Machina — pulse* (one song each; the second is a 16-against-12 polyrhythm),
  *The Elements × Thank Jeb — weave* (two songs sharing 143.5 BPM / E minor;
  cycle gates trade leads, locks duck the bass, a chance-gated fill branch) and
  *Nature's Tomb → Glass Wings — arc* (an eight-lap energy arc with lyric-search
  vocal words pulled into C minor and a two-bar break lane). Loading a sample
  puts its songs in the crate and cuts them on first use. Every sample is
  parse-tested in `npm run test:loom`. Query literals now accept quoted values
  (`entry="glass wings normal"`), and song references match titles with any
  separator.
- [ ] **LEARN light-theme labels**: the "drag to pan · wheel to zoom" hint and
  the 0/1/2 depth labels are theme-ink over the always-dark graph canvas. — XS
- [ ] **DJ "BPM" 7 px tag** inherits an accent colour at 3.6:1. — XS

### v2 — coded 2026-09-07, tsc + `npm run test:loom` green, NOT yet seen in the running app

- [ ] **Generator tiles** (`lib/loomGen.ts`): fib, fractal (thue / cantor /
  dragon / sierpinski), euclid, life, rand, frag, echo, accel, gliss —
  `name(alphabet; opts):span` on the rail owns the span; in an upper row it
  modulates. Ghost cells on the plane show what the rule plays this lap. —
  verify: load *Garden of Forking Beats*, put any song on deck, play; watch
  the colony lane change per lap and repeat on the A laps. —
  `frontend/src/lib/{loomGen,loomScore,loomEngine}.ts`, `frontend/src/views/LoomView.tsx`
- [ ] **`seed` / `form` / `ramp` directives** — reproducible dice, song form
  by lap, tempo ramp at the master wrap. — verify: the header shows `form
  AABA` and `ramp → 132`; the BPM box climbs each lap.
- [ ] **GROW pane** — Grow (mutate), Breed (sample / generation / pasted
  score), Fragment, seed, form, lineage with revert, per-lane keep. —
  `frontend/src/lib/loomEvolve.ts`, `frontend/src/state/loomStore.ts`
- [ ] **Look** — woven surface, threaded generator tiles, breathing live
  column. — verify on Midnight and Porcelain with `_audit_contrast.mjs`.

### v3 — colony mode, coded 2026-09-07, tsc + tests green, NOT yet seen in the running app

- [ ] **Colony mode** (PLANE | COLONY switch in the LOOM header): `loop` /
  `rule` / `gate` / `mod` / `colony` cells and `a -> b [on=N]` arrows;
  nested colonies with their own `meter` (7/8 groups=3+2+2, 11/8, 5/4) and
  `tempo`; the canvas is a living dish (membranes, step rings, sparks,
  slime-mould trails); double-click a colony to dive. — verify: COLONY,
  load *Inca Roads*, a song on deck, Play; the 7/8 body ticks 3+2+2 while
  the root breathes in 4/4. — `frontend/src/lib/{colony,colonyEngine}.ts`,
  `frontend/src/components/loom/ColonyCanvas.tsx`
- [ ] **Stems on first play**: a role with no stem plays the mix and
  requests separation; shards re-read when it lands. — verify: fresh song,
  Play, drums lane sounds immediately, then switches to the drum stem.

### Phase 1 — next

- [ ] DJ sampler pads: *shard mode* (pad = query, `launch(query, {at:'beat'})`
  on the master deck's clock) and pad actions in the MIDI map. — M
- [ ] PERFORM: `shard:` clip slots that re-resolve per launch;
  `nextLaunchTime` delegates to the Beat Clock (beat / half / 16th grids, phase
  that survives a stop). — M
- [ ] NodeF.I.: `shard` live node with a `roll` input; Live Out BPM binds to
  the Beat Clock; Live Out joins the master bus (it connects to
  `ctx.destination` today, `nodefiLive.ts:347`). — M
- [ ] Weave → EDIT: print a LOOM lap onto tracks as clips. — S
- [ ] Sway dims → LOOM lane locks through the `fx` CcMod path; pads punch
  momentary shard tiles. — M

### Phase 2

- [ ] Granular seam inside the Shard Engine (Metamorph worklet fed the running
  voice + the incoming shard) so the `bleed` lock is a real identity bleed. — M
- [ ] Pairing intelligence in the UI: a kept stack posts `/keep`; complements
  surface in the CRATE pane; server-side conform cache warm-up. — M
- [ ] Assistant `loom_set_score` / `loom_query` / `loom_keep` tools. — S
- [ ] `.loom` inside `.tasmo`. — S
- [ ] `backend/modules/analyzer` imports a package that does not exist
  (`edit_tools_backend`), so `/api/edit/analyzer/*` 500s. Not on LOOM's path;
  fix or retire. — S — `backend/modules/analyzer/descriptors.py:25`

---

## P1 — from the user, 2026-09-17, second list (marked done only when the user says so)

One theDAW branch, `edit-lineup-and-sway-import`, cut from `main`; the SWAY
item also needs the SwayCommand branch `sway-track-menu` and a `SWAY_REF` bump
in `.github/workflows/release.yml` once that lands.

- [ ] **EDIT: a clip drags to any lane, and a gap makes a lane.** The lane under
  the pointer is the target (`laneTargetAtY` in
  `frontend/src/components/audio/laneTarget.ts`); the band at a lane's edge,
  the space above the first lane and the space below the last are "a new lane
  here", drawn as a line with a label, made on release (`insertTrack` in
  `frontend/src/state/editorStore.ts`). Library and desktop drops use the same
  resolver. — S
- [ ] **EDIT: zoom out to the whole set.** The zoom floor is 0.25 px/s
  (`ZOOM_MIN`), the toolbar keys step by 1.25x, and the fit key (Shift+F, the
  frame icon) fits any length. — XS
- [ ] **Send to EDIT fills lane 1 first.** `sendAudioToEditor` in
  `frontend/src/lib/sendToTargets.ts` takes the first empty lane; when every
  lane holds something, "Own lane in EDIT" adds one and "End of EDIT lane 1"
  appends after lane 1's last clip. — XS
- [ ] **EDIT starts with six empty lanes.** `DEFAULT_TRACK_COUNT` in the editor
  store; a project with no lanes loads the same six. — XS
- [ ] **EDIT beat match (DJ sync).** `frontend/src/lib/beatMatch.ts`: the
  stretch ratio picks the half/double-time reading nearest unity, the first
  analysed beat goes on the project grid, the project tempo follows the
  master. Right-click a clip: "Beat match to project (N bpm)" and, with more
  selected, "Beat match N selected to this clip". Toolbar: SYNC beside the BPM
  field (one clip: to the project; several: the rest to the first selected).
  Clips with no library analysis are skipped and the LOG says so. A clip's
  readout shows its matched tempo (`AudioClip.bpm`). — M
- [ ] **SWAY: right-click a track adds audio from the library, a file or a
  link.** Cockpit posts `sway/track-menu`, the host opens `SwayTrackMenu`
  (`frontend/src/components/sway/SwayTrackMenu.tsx`) and answers
  `sway/load-audio` with a library URL; every source is imported to the
  library first. Cap `host-track-menu`. Cockpit side in SwayCommand branch
  `sway-track-menu`. — M
## P1 — from the user, 2026-09-17 (marked done only when the user says so)

Three branches, each cut from `main`; they merge in any order. The legend goes
on `meter-map-tempo-flags` because the on-screen meter map exists only there.

- [ ] **The meter map has no legend on screen.** `drawLegend` in
  `frontend/src/components/layout/meterMapDraw.tsx` runs only inside
  `meterMapSvgText`, which builds the saved file. `MeterMapChart` in DETAILS
  draws `drawMeterMap` alone, so the family colours, the guess hatch, the
  8TH/16TH badge, the tempo flag and the syncopation lane are unexplained.
  Plan: one list of legend items in `meterMapDraw.tsx` feeds both the file and
  a `MeterMapLegend` in `MeterMapChart.tsx`; `RhythmBlock.tsx` shows it under
  the map as wrapping HTML rows at 12px bold. — XS — branch
  `meter-map-tempo-flags`
- [ ] **The LOOM right rail folds.** The CELL / CODE / CRATE rail
  (`frontend/src/views/LoomView.tsx:138`, `w-96`) takes Score's collapsible
  rail. Folded, it is a 32px strip (`w-8`, thinner than Score's `w-10`) with the
  rail's name written down it, and a click anywhere on the strip opens it. Open,
  the fold key sits at the rail's inner edge, left of the tabs. The state is
  remembered per viewer (`loom.railCollapsed.v1`). One shared component,
  `frontend/src/components/ui/CollapsibleRail.tsx`, serves LOOM and Score. — S —
  branch `rails-collapse-loom-score`
- [ ] **The Score notation rail follows the same rules.** The folded strip
  (`frontend/src/components/layout/ScoreView.tsx:546`) goes from `w-10` to
  `w-8`, the whole strip opens the rail, and the fold key moves from the left
  end of the header to the right end, beside the score. — XS — branch
  `rails-collapse-loom-score`
- [ ] **The library stays on the last clicked track across its tabs.** Stems,
  MIDI and Score list every song's group from the top of the scroll region
  (`frontend/src/views/LibraryView.tsx:1374-1405`), so after clicking song X in
  Tracks the other tabs open somewhere else. Plan: on every tab switch the
  selected track's group scrolls into view and wears the accent ring; a song
  with nothing in that tab gets a line saying so, with the key that makes it
  (Separate stems, Convert to MIDI, Open in SCORE); a group's title selects that
  song; returning to Tracks scrolls the selected row back into view. — S —
  branch `library-follow-track-info`
- [ ] **An INFO tab in the library strip.** After Score, a sixth tab shows the
  selected track in one column: everything DETAILS shows (identity, generation
  settings, prompt, notes, tags, lyrics, analysis, embedded tags, ffprobe,
  notation identity, the cached meter reading, chimera sources) and everything
  the lineage inspector shows (parents and children with their relation, counts
  by relation, ancestors and descendants, recurring prompt terms and tags), plus
  the track's stems, MIDI and scores. Keys at the top open the full DETAILS tab
  and the LINEAGE window. New file
  `frontend/src/components/library/TrackInfo.tsx`; reads
  `/api/library/entries/{id}`, `/api/analysis/{id}`, `/api/rhythm/{id}`,
  `/api/notation/{id}/identity` and `/api/library/{id}/lineage`. — M — branch
  `library-follow-track-info`

---

## P1 — from the user, 2026-09-17, second list (marked done only when the user says so)

One theDAW branch, `edit-lineup-and-sway-import`, cut from `main`; the SWAY
item also needs the SwayCommand branch `sway-track-menu` and a `SWAY_REF` bump
in `.github/workflows/release.yml` once that lands.

- [ ] **EDIT: a clip drags to any lane, and a gap makes a lane.** The lane under
  the pointer is the target (`laneTargetAtY` in
  `frontend/src/components/audio/laneTarget.ts`); the band at a lane's edge,
  the space above the first lane and the space below the last are "a new lane
  here", drawn as a line with a label, made on release (`insertTrack` in
  `frontend/src/state/editorStore.ts`). Library and desktop drops use the same
  resolver. — S
- [ ] **EDIT: zoom out to the whole set.** The zoom floor is 0.25 px/s
  (`ZOOM_MIN`), the toolbar keys step by 1.25x, and the fit key (Shift+F, the
  frame icon) fits any length. — XS
- [ ] **Send to EDIT fills lane 1 first.** `sendAudioToEditor` in
  `frontend/src/lib/sendToTargets.ts` takes the first empty lane; when every
  lane holds something, "Own lane in EDIT" adds one and "End of EDIT lane 1"
  appends after lane 1's last clip. — XS
- [ ] **EDIT starts with six empty lanes.** `DEFAULT_TRACK_COUNT` in the editor
  store; a project with no lanes loads the same six. — XS
- [ ] **EDIT beat match (DJ sync).** `frontend/src/lib/beatMatch.ts`: the
  stretch ratio picks the half/double-time reading nearest unity, the first
  analysed beat goes on the project grid, the project tempo follows the
  master. Right-click a clip: "Beat match to project (N bpm)" and, with more
  selected, "Beat match N selected to this clip". Toolbar: SYNC beside the BPM
  field (one clip: to the project; several: the rest to the first selected).
  Clips with no library analysis are skipped and the LOG says so. A clip's
  readout shows its matched tempo (`AudioClip.bpm`). — M
- [ ] **SWAY: right-click a track adds audio from the library, a file or a
  link.** Cockpit posts `sway/track-menu`, the host opens `SwayTrackMenu`
  (`frontend/src/components/sway/SwayTrackMenu.tsx`) and answers
  `sway/load-audio` with a library URL; every source is imported to the
  library first. Cap `host-track-menu`. Cockpit side in SwayCommand branch
  `sway-track-menu`. — M

## P1 — from the user, 2026-09-16 (marked done only when the user says so)

- [ ] **A notation writing tool in SCORE.** Write and correct notation by hand
  over what the maker produced: place, move and delete notes on a staff or a
  tab line, change durations, add chord symbols, and save the result as a new
  MusicXML or alphaTex artifact beside the generated one. Study first: what
  OSMD and alphaTab expose for editing, versus a small editor of our own over
  the MusicXML. — L — `frontend/src/components/layout/ScoreView.tsx`
- [ ] **Part names in the SCORE PAGE view.** STRIP pins every part's name to
  the left edge while it scrolls; the PAGE view still names parts only on the
  first system of the score, so page 2 onward has unnamed staves. Print a name
  or abbreviation on every system. — S — `frontend/src/components/layout/ScoreView.tsx` (MusicXmlPreview)

---

## P1 — from the user, 2026-09-14 (marked done only when the user says so)

Queued behind the sixteen branches waiting for review; the user asked for these
before the merge to `gantasmo/main`. Three of them land on code that one of those
branches rewrites, noted per item.

- [ ] **No emoji on the action keys: CREATE, PROCESS, PROCESS STACK and the
  rest.** A repo-wide scan of `frontend/src` and `electron-ui` for characters in
  U+1F000–U+1FAFF finds emoji in only two places: `SlidePanel.tsx:195` (the
  slot lock) and the bundled Underfit dashboard the UNDERFIT tab embeds (five of
  them in
  `electron-ui/release/win-unpacked/resources/python/underfit/dashboard/index.html`).
  Nothing emoji-bearing sits on the footer's action key
  (`components/layout/ProcessingLog.tsx:335-530`, the glyphs are SVG paths in
  `components/audio/transportGlyphs.tsx`). So the first step is to find what the
  user is looking at in the running app — most likely the Underfit dashboard's
  own buttons, since the UNDERFIT tab is the one workspace theDAW does not
  draw. Then strip them. — S — `components/layout/SlidePanel.tsx:195`,
  the Underfit dashboard's `index.html`
- [ ] **No emoji on Discard.** Three Discard controls:
  `components/audio/MicRecorder.tsx:360` (a `Trash2` icon plus the word),
  `components/layout/AutosaveRecoveryNotice.tsx:64`,
  `components/layout/sing/LyricsEditor.tsx:67`. None carries an emoji in the
  current tree; check the running app and strip whatever is there. — XS
- [ ] **No emoji on the bottom panel tab titles.** The ten tabs are built from
  one table — Levels, Visualize, MIDI, Sequence, DRAW, Score, Sing, Lyric,
  Details, SLIDE — each with a lucide icon, no emoji in the source. Same as
  above: find what is on screen, then strip. — XS —
  `components/layout/BottomMultiTabPanel.tsx:50-60`
- [ ] **EDIT: FX and TOOLS are one kind of dropdown, and FX opens under its
  button.** TOOLS is a button that opens the shared `ContextMenu` anchored at
  `{ x: rect.left, y: rect.bottom + 4 }` — under itself
  (`components/audio/WaveformEditor.tsx:3876-3889`, menu at `:4142-4160`). FX is
  a clip-header button that opens the track FX rack through `openFxRack` /
  `fxRackAnchor` (`components/audio/WaveformEditor.tsx:4720-4730`), a different
  surface that lands to the left. Give FX the TOOLS treatment: the same trigger
  form, the same `ContextMenu`, opening under the button. **Touches
  `edit-lane-fx-midi-crash`**, which moves the rack onto `lib/popoverPlacement.ts`
  and the open rack into `state/trackFxRackStore.ts` — do this after that branch
  merges, on top of it. — S
- [ ] **Icon-only controls with the word in a tooltip: IMPORT, Recent audio,
  Play, Pause, All.** Each keeps its icon, drops its visible word, and names
  itself in a hover tooltip and in `aria-label`. — S —
  `components/layout/ImportMenu.tsx` (the IMPORT button and its Recent sibling,
  `:274`), `components/audio/WaveformEditor.tsx:4556-4570` (the editor's Recent
  audio and Recent MIDI menus), `components/ui/KnownFilesMenu.tsx` (the `label`
  prop every Recent trigger renders), `components/audio/PlayerFooter.tsx` (the
  transport), `views/MixView.tsx:618` (All). **Touches `midi-dock-readable` and
  `footer-create-key`**, which already take the dock and the footer to
  glyph-plus-DockTip; follow the same `DockTip` pattern rather than a second
  tooltip mechanism.
- [ ] **"Up Next" reads "Next".** The footer's right-hand block.
  — XS — `components/audio/PlayerFooter.tsx:868`
- [ ] **"COMMIT EDIT" reads "MIXDOWN".** The button and its busy caption
  ("COMMITTING…" → "MIXING DOWN…"), and the orb tip that names it. — XS —
  `components/audio/WaveformEditor.tsx:3959`,
  `components/audio/OrbTipBubble.tsx:49`

## P1 — from the user, 2026-09-13 (marked done only when the user says so)

- [ ] **METER MAP in DETAILS: draw the map.** The block shows the engine's
  summary sentence as a text box. The user wants the visual map from the UNCANNY
  maps page, everything it shows and more, fed by the current engine. That page
  draws, per track: a facts column; a time ruler with tempo-change flags; one
  lane of meter blocks sized by time, coloured by bar-length family (fours,
  threes and compound, fives, sevens, twos, the long and odd), hatched when
  confidence is under 0.10, labelled with signature and grouping, badged 8TH or
  16TH when read at the tatum, with hover and focus tooltips carrying the
  numbers; a syncopation-per-bar lane (LHL); chips for polymeter, cross-rhythms
  and swing; a legend. The family colours encode data and stay inside the map;
  everything around it follows the one-accent item below. REPORT carries the
  same drawing. Reference: artifact
  `claude.ai/code/artifact/8e0033a4-d9d0-4a62-a599-c9ecd4022fb0`, saved with its
  render script at
  `C:\Users\dtruj\.claude\projects\g--Users-dtruj-Dev-theDAW\4df20534-aae7-4dce-952f-b7c88f167f76\tool-results\artifact-8e0033a4-1789170827-a5ab.html`.
  Data: `meter_map`, `tempo.segments`, `bar_starts`, `lhl`, `offbeat`,
  `syncopation`, `polymeter`, `cross_rhythms` from
  `backend/modules/rhythm/engine.py`. — M —
  `frontend/src/components/layout/RhythmBlock.tsx:190-300`
- [ ] **One accent colour, taken from the theme.** Buttons, knobs and sliders
  use many neon colours. They take the theme's accent and contrast with the
  theme. A glow marks state: the selected control, an armed or recording
  control, and other states where a glow carries meaning. DETAILS tints each
  section its own colour: NOTATION IDENTITY amber (`DetailsView.tsx:339`),
  ANALYSIS emerald (`:395`), sky (`:456`), purple (`:505`), METER MAP fuchsia
  (`RhythmBlock.tsx:190`). The 2026-09-13 screenshot also marks the header icon
  buttons (phone, help, IMPORT, menu), the DETAILS / BOTH / MEDIA switch with its
  expand button, and the LIBRARY / MEDIA tabs. App-wide; DETAILS, the header and
  MIDI first. — L — `frontend/src/lib/editThemes.ts`, `frontend/src/index.css`,
  `frontend/src/components/layout/DetailsView.tsx`,
  `frontend/src/components/layout/Shell.tsx:292`
- [ ] **Footer buttons in the transport style.** CREATE and every other footer
  button take the style of the LOOP / START / PLAY / END / RAND plate. — S —
  `frontend/src/components/audio/PlayerFooter.tsx:776` (transport plate), `:934`
  (CREATE and the other workspace actions)
- [ ] **The footer speech bubble.** Shaped as a speech bubble, in theme colours
  (not purple), placed further left. It takes the place of the "Drag to move"
  label under the assistant orb. — S —
  `frontend/src/components/audio/OrbTipBubble.tsx`,
  `frontend/src/components/audio/PlayerFooter.tsx:724-728`,
  `frontend/src/orb-kit/styles/gantasmo-orb.css:442`
- [ ] **MIDI tab layout.** Four or more stacked rows sit above the piano roll:
  the sub-tab bar; input, song search, ANALYZE, LOAD, .MID, BEAT, VALIDATE, ARP;
  the VIRTUOSO sliders with key, style and groove; CAPTURE, RESET, STRUCTURE,
  BUILD SONG; the piano roll toolbar. They take most of the vertical space, use
  mixed neon colours, and share no grouping or alignment. One compact, uniform
  arrangement on theme accents. — M —
  `frontend/src/components/layout/MidiPanel.tsx:480,585,593,596,655`,
  `frontend/src/components/audio/VirtuosoControls.tsx`,
  `frontend/src/components/audio/PianoRoll.tsx:582`,
  `frontend/src/components/audio/ArpeggiatorPanel.tsx:178`,
  `frontend/src/components/audio/AiComposePopover.tsx:107`
- [ ] **F1 vocal suite, piece 2: tuning and pitch correction.** Next in the
  plan's order, confirmed by the user 2026-09-10. Plan:
  `docs/guides/vocal-suite-plan.md` (`ac18a52`). Piece 1, a CUDA torch in the
  stems sidecar, is done: torch 2.7.1+cu128, CUDA available, separation routed
  to the GPU. Brief:
  - New `backend/modules/vocal/render/` consuming `VocalArtifact` (`schema.py`,
    the f0 curve and voiced mask from `preprocess/f0_curve.py`).
  - Pure functions: `retune_targets(f0, target)` with target = scale/key, the
    chord track, or the SCORE melody; `retune_ratio` with retune speed, strength
    and a transition time; formant preservation on by default; a PSOLA or
    phase-vocoder render that passes unvoiced frames through.
  - Tests first, on synthetic vowels: a sung sine with vibrato snapped to a
    scale, measured as cents error per frame; formant preservation measured as
    spectral envelope distance before and after.
  - UI later, in SING. It corrects the isolated vocal stem, never the mix, and
    the UI says so.
  — L — `backend/modules/vocal/`
- [ ] **LOOM tendrils: part of the cell or colony.** The user: "They should look
  like they are a part of the cell or colony, not like a South Park Studios paper
  cutout." Tendrils here are the Verlet strands (`components/loom/tendril.ts`,
  drawn in `ColonyCanvas.tsx:472-578`), not NodeF.I.'s tendril control. Measured
  2026-09-10, headless at 1920x1080; screenshots and the probe are in
  `C:\Users\dtruj\.claude\projects\g--Users-dtruj-Dev-theDAW\plans\loom-tendrils\`.
  - Fix 1, prerequisite: the orb sprite draws the membrane near 0.5 r while the
    selection halo, meter ticks and label sit at r (`ColonyCanvas.tsx:447-467`),
    and tendrils anchor at `rimRadius(...) * 0.90` (`:496-499`), so a strand into
    a colony ends outside the bubble. The sprite is `r * ORB_REGION` (4.3) px and
    the shader raymarches a sphere of `u_radius` 0.42 (colony) or 0.33 (loop) in
    region space (`orbParamsFor`, `:1096,1121`; `gooeyOrb.ts:97`); the camera
    (`ro` at z 3, focal 1.8) projects those to about 0.5 r and 0.4 r. Measure the
    sprite's alpha along a ray for a loop and a colony at known r, then set
    `u_radius` or the camera so the projected sphere fills r. Acceptance: visible
    rim, halo and anchor agree within 3 px for both kinds.
  - Fix 2: re-parenting regrows strands. Ropes are keyed `parent|from|to`
    (`ColonyCanvas.tsx:491`) and deleted when the key vanishes (`:578`); growth
    that envelops a loop (`colonyGrow.ts:179-196`) re-points the wires, so each
    strand is deleted and regrows over 6.5 s. Carry grow, pts and rest across a
    key change that keeps the wire's identity; `stepRope` already re-seeds on a
    large anchor jump (`tendril.ts:253-263`).
  - Fix 3: under `prefers-reduced-motion` `stepRope` never runs
    (`ColonyCanvas.tsx:514`), leaving two-segment stubs. Create ropes fused
    (grow = 1) and skip only the physics.
  - Fix 4: `flareA: rimA * 0.42 * k2` (`ColonyCanvas.tsx:534-535`) is a 120 px
    half-width blob on a 300 px colony. Cap it at a few times the strand's mid
    width.
  - The look: strands are flat gradient ribbons with hard edges (`drawRibbon`,
    `tendril.ts:362-418`) painted after the bodies (`ColonyCanvas.tsx:429-470`).
    Draw strands before the orbs. Add up to a few root capsules per orb to
    `mapBlob` (`gooeyOrb.ts:93-98`) joined by a smooth minimum, so the membrane
    bulges into the strand; on colonies the roots take the glass material
    (`u_body` 0.06). Paint the strand as a lit tube: the orb's two colours along
    its length, a highlight toward the shader's light, a darker edge, the
    `u_glowStrength` falloff and the body's alpha, composited with the orbs'
    blend. The orb shader is the user's port of Tamino Martinius; if the user has
    a reference for the strand material it goes first, so ask before starting
    the material.
  - Also seen: the colonies template places three colonies of radius 280 to
    340 px on a ring of 120 + 6n px (`ColonyCanvas.tsx:199`), so the bubbles
    overlap by most of their area; whether the physics spreads them needs a live
    look. No console errors; strands grow, bow and fuse as `tendril.test.ts`
    describes.
  - Acceptance: at a loop and at a colony, a still frame at 1920x1080 shows no
    seam at either end and the strand shares the body's colours and highlight;
    `tendril.test.ts` passes unchanged and the Node rate tests hold. Order: fix
    1, draw order, shader roots, tube paint; fixes 2 to 4 alongside. Measure with
    `probe_loom_tendrils.mjs` at 1920x1080 (the shell's zoom is 1.0 at 1600x900,
    which hides pointer bugs); judge seams on stills, since headless runs at
    2.7 fps. `npm run clean` after any build. The user looks before it is
    committed.
  — M — `frontend/src/components/loom/ColonyCanvas.tsx`,
  `frontend/src/components/loom/tendril.ts`,
  `frontend/src/components/loom/gooeyOrb.ts`, tests via `npm run test:loom`
- [ ] **Copilot on PR #172 (merged as `3e97b0f`): the wrapper guard reads a fixed
  window.** It pairs a counter-zoom with a width or height only within
  four lines either side, so moving the size above the zoom or adding
  properties between them hides the regression while the test passes. Inspect
  the whole style object, or parse the TSX. — XS —
  `frontend/src/components/library/lineageWrapperGuards.test.ts:37-40`
- [ ] **Example projects are one audio track each.** Each of the five `.tasmo`
  files in `examples/projects/` holds one track with one embedded clip, the
  mastered song, plus 4 to 13 locators at meter changes. Gravy adds a
  three-effect chain on that track and Miracle Mile six scene names. None
  carries stems, MIDI, lyrics, a score, a PERFORM grid or controller mappings. A
  sample project opens as a working session: the song split into stem tracks,
  MIDI converted from each stem, aligned lyrics, the score, a PERFORM grid with
  clips and scenes, FX chains on the stems, and the meter-map locators, built by
  `scripts/build_examples.py` from each UNCANNY entry's own stems, MIDI, lyrics
  and notation in the library. — L — `scripts/build_examples.py`,
  `examples/catalog.json`, `backend/modules/project/tasmo_project.py`

## P1 — security, from the 2026-09-13 review of the known-paths work (not from the user)

- [ ] **The backend answers any client on the LAN.** It binds 0.0.0.0 with CORS
  `*`. `refuse_cross_site` refuses pages from other origins and lets every
  request without browser headers through, so a script on another machine
  reaches every route. Two routes predate the known-paths work and need the
  gate most: `POST /api/project/save` with `embed_audio` reads any path named
  in the body into a `.tasmo` written at any path (`_gather_embedded_audio`),
  and `POST /api/plugin/reveal` starts Explorer on any existing path. Design
  from the review: the backend generates a per-launch secret; Electron main and
  the Vite proxy send it as a header (the Pinokio launcher starts both
  processes, so it can hand the secret to each); write, pick, reveal, backup and
  places routes require it; the Host header is checked against loopback, the
  machine's names and its LAN addresses. The known-paths work adds two reads
  the gate covers: `GET /api/places/recent` lists remembered absolute paths to a
  caller that sends no browser headers, and `GET /api/places/file` serves such a
  caller any file the desktop app downloaded (source `download`). — M —
  `backend/lib/cross_site.py`, `backend/modules/places/router.py`,
  `backend/modules/project/router.py`, `backend/modules/plugin/router.py`,
  `backend/server.py`, `electron-ui/main/index.ts`, `frontend/vite.config.ts`

## P1 — from the user, 2026-09-12 (marked done only when the user says so)

- [ ] **Meter maps have no UI at all.** The whole rhythm engine ships and is
  reachable over HTTP, but nothing in the frontend calls it: `grep "api/rhythm"
  frontend/src` returns zero hits. The user wants it in four places: **Library >
  right-click a track > Meter map**, and then in **SCORE**, **SING** and
  **STUDY**. Backend is ready — `GET /api/rhythm` (capabilities), `GET
  /api/rhythm/{entry_id}` (the stored map), `POST /api/rhythm/{entry_id}/run`,
  `POST /api/rhythm/file`, producing `meter_map` with per-segment
  `start_sec`/`end_sec`/`bpm` plus syncopation, polymeter and cross-rhythm
  (`backend/modules/rhythm/engine.py:1776,1849,1990`). The library menu already
  has the exact pattern to copy: the "Run analysis" item at
  `frontend/src/views/LibraryView.tsx:1312` calling `runJobForEntry(id, kind)`
  at `:138` — note its `kind` union is `'analysis' | 'stems' | 'midi'` and needs
  a `'rhythm'` arm. SCORE/SING/STUDY anchors: `ScoreView.tsx` toolbar,
  `frontend/src/components/layout/sing/SingScoreView.tsx:89` (BOTH and STUDY
  share a two-column layout; STUDY is `pane === 'analysis'`), and
  `LyricAnalysisPane.tsx` for the STUDY column. The engine's own write-up is
  `docs/guides/rhythm-analysis.md`. — M
- [x] **The assistant CHAT PANEL rendered all-white over SCORE.** Diagnosed and
  fixed on branch `fix-assistant-panel-has-no-background` (acf4283): orb-kit was
  ported from a host whose Tailwind config defined `surface`/`border`/`primary`/
  `muted`, which theDAW never did, so all 71 uses of `bg-surface/95`,
  `border-border`, `text-primary`, `text-muted`, `bg-primary` and `from-primary`
  compiled to nothing and the panel was a bare `backdrop-filter: blur(8px)` with
  no fill. It showed whatever was behind it; SCORE is the one tab with a white
  ground. Latent since `f473bb8`, not a v0.1.7 regression. Awaiting the user's
  visual pass.
- [ ] **The ORB itself over a white backdrop — the user's call.** `69fa44d`
  removed the orb's only opaque fill in three places at once
  (`gantasmo-orb.css:223` `background: transparent`, `FerroOrbCore.tsx:49`
  `premultipliedAlpha: false`, `:98,104` clear-to-alpha-0 + `scene.background =
  null`), which is exactly what "the orb loses its disc" asked for. The cost is
  that the orb has no ground of its own, so over a white page it is a white
  cloud: the body is near-black metal and what reads as "the orb" is the bloom,
  which at 1.65 gain clamps toward opaque white. Two candidate changes, both of
  which alter a look that was chosen deliberately, so neither is made:
  (a) a feathered radial ground on `.orb-2x .orb-core-main` — opaque under the
  body, gone before the rim, so no edge against the app; (b) drop
  `premultipliedAlpha: false` and premultiply in the shader instead, which
  three.js documents as the correct path and which may itself be why the bloom
  blows out in Chromium. The failure-path half of this IS fixed on the branch
  above (no-WebGL now paints a body; a context loss now rebuilds instead of
  retiring the orb for the session). To decide it: drag the orb onto a white
  SCORE page and then back onto the dark rail — if it flips white/dark with the
  backdrop, (a) is the fix. — S
- [ ] **aubio cannot read mp3, and says so on every import.** `chimera detect:
  aubio could not handle <file>.mp3 (AUBIO ERROR: source_wavread: Failed opening
  ... could not find RIFF header) - falling back to librosa`. The fallback works,
  so this is noise, not breakage — but it reads as a failure in the LOG on every
  mp3. aubio's wavread backend is WAV-only; either probe the extension and skip
  straight to librosa for anything that is not WAV, or decode to a temp WAV
  first. — XS — `backend/modules/chimera/detect.py:62`

## P2 — follow-ups from the 2026-09-12 audit (not from the user; my own leftovers)

Each one was found while building the five branches of 2026-09-12 and deliberately
left undone, with the reason. None blocks those branches.

- [ ] **The HF token card never shows a transport failure.** `fetchHfStatus` now returns
  `error: {kind, message}` when the backend is unreachable, but `HfTokenField` reads only
  `logged_in`/`available`, so the message is produced and dropped. ~4 lines: render it in the
  existing `role="alert"` paragraph. — XS — `frontend/src/components/ui/HfTokenField.tsx`,
  `frontend/src/lib/hfAuthClient.ts`
- [ ] **`questMidiClient.wsUrl()` has no same-origin branch**, unlike `xrControlClient`, so its
  own docstring ("rides the Vite dev proxy") is not what the code does and a phone on the LAN
  connects to itself. Behaviour change, so it was out of scope for a loopback-literal pass. — XS
  — `frontend/src/state/questMidiClient.ts:31`
- [ ] **502 means two different things across the backend.** `hfauth` now answers 503 +
  `x-thedaw-hop` for a failure it does not own, but `tour`, `suno`, `ytimport`, `genaiproxy` and
  `/api/generate` still use 502 for upstream failures. They always carry a FastAPI `detail`, so
  nothing is mislabelled today, but the convention should be one thing. — S — `backend/modules/*/router.py`
- [ ] **The I/O device store has no sequence tests.** `ioResolve.test.ts` covers the pure table;
  what is untested is ordering — enumerate-before-permission then grant, `devicechange` while a
  device is selected, the notice raised exactly once across repeated resolves, legacy adoption
  being a no-op once a choice exists. That is where this class of bug lives. — S —
  `frontend/src/state/ioDevicesStore.ts`
- [ ] **Dead exports left by the I/O work:** `currentDeviceIds` (`IoDeviceSelect.tsx`),
  `followSurfaceSink` and `activeThruPortId` (`ioDevicesStore.ts`), `djEngine.getCueSinkId`,
  `vocalToMidi.listAudioInputs`. — XS
- [ ] **`VirtuosoControls` passes `showInstrument` against that prop's stated contract** — the
  groove-reference picker synthesizes nothing, yet offers a dropdown that rewrites the app-wide
  soundfont. Removing it takes away a control that existed before, so it is the user's call. — XS
  — `frontend/src/components/audio/VirtuosoControls.tsx:301`
- [ ] **`LibraryView` still runs its own `/api/library/_all/midi` and `/stems` fetches** rather
  than the shared `libraryIndex`. Third copy, never collapsed. — XS —
  `frontend/src/views/LibraryView.tsx:305,311,345,354`
- [ ] **A camera picker needs a change in `gantasmo/VJ-9000`.** deviceIds are salted per origin,
  and the VJ runs in an iframe on the backend origin, so a list enumerated by the host is
  meaningless inside it. The list has to be enumerated in the child and sent up; the current
  protocol is boolean-only. Until then theDAW shows a camera STATUS row, not a picker. — M —
  `frontend/src/views/VJView.tsx:103-107,626-628`
- [ ] **FlashAttention 3 (GH-127).** A wheel for our exact stack exists in the same mjun0812
  release we already pin, but it is a different package with a different API (our code imports
  `index_first_axis`, which FA3 has no equivalent for) and its speedup targets datacentre cards —
  nothing for Turing or Ampere. Revisit only with a hardware reason. — M — `pyproject.toml`,
  `stable_audio_3/models/transformer.py:22-39`
- [ ] **Small mono labels outside the MIDI dock (added 2026-09-13).** The midi-dock-readable
  branch takes everything inside `[data-keyscope="piano-roll"]` to 12px Orbitron legends and the
  bold sans. Outside it, the Shell wordmark, the Mobile Access / companion popover, the Panels and
  LOG bars, the `IoDeviceSelect` defaults the settings modal uses, the groove `LibraryPicker`
  the SHAPE row's PICK key opens (a modal portaled to the page body), the `MidiMapper` pill the
  SEQUENCE tab floats top-right (9px Orbitron), and `KnownFilesMenu`'s compact Recent trigger
  that every surface outside the dock uses (9px Orbitron) still draw 8-11px, much of it IBM Plex
  Mono. Take them to the same type in a pass the user can check. — S —
  `frontend/src/components/layout/Shell.tsx:311,396,446-600,824-857`,
  `frontend/src/components/audio/IoDeviceSelect.tsx:83,86`,
  `frontend/src/components/audio/LibraryPicker.tsx:584-816`,
  `frontend/src/components/audio/MidiMapper.tsx` (the pill variant's `text-[9px]`),
  `frontend/src/components/ui/KnownFilesMenu.tsx:265` (the non-flyout size)

## P1 — from the user, 2026-09-11 (marked done only when the user says so)

- [ ] **LOG strip: the gradient runs far past the readouts.** Only the things
  that float over the strip (the system stats, the library-rail handle) get the
  dark gradient, and only behind themselves. The log readouts extend to the edge
  of the panel / window unless a floating element sits over them. The LOG body
  is exactly as wide as the tab that opens and closes it. — S —
  `frontend/src/components/layout/Shell.tsx:825-860` (LOG strip section,
  `logWidth`), `frontend/src/components/layout/ProcessingLog.tsx:296` (the
  `linear-gradient(to left, rgba(0,0,0,0.85) 60%, transparent)` backdrop),
  `frontend/src/state/bottomPanelStore.ts` (`logWidth`)
- [ ] **CHORDS: bring the chord visual to the NOW line.** The section reads as
  crowded at the top and the current chord sits at the far left. The sounding
  chord belongs on the NOW line with the next chord to its right and the
  previous to its left, and the section gets a nicer layout. — S —
  `frontend/src/components/layout/score/chords/ChordPlayAlong.tsx`,
  `frontend/src/components/layout/score/chords/ChordStripCanvas.tsx`,
  `frontend/src/components/layout/score/chords/ChordDiagram.tsx`

## P2 — device I/O follow-ups (added 2026-09-12, from the global I/O menu)

The global input/output menu shipped with these three deliberately left out;
each is a written reason in the PR, not an oversight.

- [ ] **Camera picker for the VJ (phase 2).** theDAW cannot enumerate cameras for
  the VJ: deviceIds are salted per origin and the VJ iframe runs on the backend
  origin, so a host-side list is wrong by construction. The list has to be
  enumerated INSIDE the VJ and travel up. Protocol to add: host →
  `{type:'sa3-vj/camera', on, deviceId?}`, VJ →
  `{type:'sa3-vj/camera-devices', devices:[{id,label}], active}`. Needs
  `gantasmo/VJ-9000` cloned, edited, rebuilt and `electron-ui/resources/vj-dist`
  re-staged. Note `frontend/src/state/slideStore.ts` (`VisualControl.kind` is
  `'range' | 'toggle'`) cannot carry a picker — both `ingestManifest` and
  `applyFromVj` branch exhaustively, so a select kind is a four-site change
  across two repos. — M — `frontend/src/views/VJView.tsx:103-107,626-628`,
  `backend/modules/vj/sidecar.py:181`
- [ ] **Output routing for the 17 edit-module windows.** Each page owns its own
  AudioContext inside a same-origin iframe, so a `'thedaw-sink'` message would
  only move the two pages that play through an `<audio>` element — a control
  that works for 2 of 17 is worse than none. Doing it properly means the pages
  register their context with `theDAWKit` (a new `registerContext`) and the kit
  applies `setSinkId` to both. Extend
  `frontend/src/components/audio/effects/editModulesContract.test.ts:31` with the
  fourth protocol token so the pages cannot drift. — S —
  `frontend/public/edit-modules/module-kit.js`,
  `frontend/src/components/audio/EffectGuiStage.tsx:122-129`
- [ ] **Assistant voice input off the Web Speech API.** `AssistantPanel` builds a
  `SpeechRecognition`, which has no device parameter, so it always takes the OS
  default no matter what the I/O menu says (the menu says so, in words).
  Migrating it to the `MediaRecorder` + `/api/assistant/transcribe` path the
  UNDERFIT orb already uses would put it on the chosen microphone. — S —
  `frontend/src/orb-kit/AssistantPanel.tsx:183`,
  `frontend/src/views/underfit/UnderfitAssistantOrb.tsx:333-345`

## P0 — breaks the app's primary action

- [ ] **ABORT is client-side only.** No cancel route exists; the job finishes on the GPU, writes artifacts to the library, and holds `_generation_job_lock` so the next CREATE queues behind it. — M — `backend/server.py:105,1351`, `frontend/src/state/generateStore.ts:759`
- [ ] `[verify]` **Footer CREATE silently runs local SA3 when Suno/Lyria is selected**, then labels the result with the cloud model's name. The footer button moved into `PlayerFooter` and `generateStore` grew a model-resolution preflight ("No usable model is configured…"); whether a cloud selection now routes to the cloud path is unverified. — S — `frontend/src/state/generateStore.ts:463-511`, `frontend/src/components/audio/PlayerFooter.tsx`

## P1 — user-visible defects

### Feedback that never reaches the user

> The single most common failure in this codebase: a message is produced and never rendered.

- [ ] **DJ: 16 status messages are produced and never rendered.** The old status var became `flash`; there are 16 `setFlash(...)` writers and an effect that clears it, but no JSX reads it. Bad file drop, "create a set first", BPM out of range, sync/eject confirmations still read as buttons that do nothing. — XS — `frontend/src/views/DJView.tsx:562,709`
- [ ] **MIX: PROCESS CHAIN fails with zero visible feedback** — no toast, no log. No error path found in `MixView` this pass. — S — `frontend/src/views/MixView.tsx`
- [ ] **VJ: failure path is a 40-second silent retry then a bare message**; `MAX_LOAD_RETRIES = 20`, `detail` is set and never rendered. SwayView does this correctly. — XS — `frontend/src/views/VJView.tsx:60,285,329`

### Dead controls and dead state

- [ ] `[verify]` **DJ: MIDI "Ignore" buttons.** The store is now consumed by the MIDI-map panel; whether the live MIDI input handler actually filters ignored controls is unverified. — XS — `frontend/src/views/DJView.tsx:2398`
- [ ] **DJ: `DeckRack` (~180 lines) is defined and never rendered.** Downgraded to cleanup: a stem-separation Abort now exists outside it (`abortStems`), so the only user-facing consequence is gone. Delete the component. — XS — `frontend/src/views/DJView.tsx:1290,1471` (abort: `:1521,1624`)
- [ ] **DJ: automix never beatmatches** — the `setInterval` captures a stale `syncDeck` closure. The prepared-sets work (`#140`) touched the loader in this interval but not the closure. — S — `frontend/src/views/DJView.tsx:728,985,1012`
- [ ] **DJ: sampler per-pad gain / loop / choke are dead state** — `setPadOpts` has no caller. — S — `frontend/src/state/djSamplerStore.ts:23`
- [ ] **MAKE: the `DL` auto-download toggle has no consumer** — persisted, mirrored to the assistant, rendered twice, downloads nothing. — XS — `frontend/src/views/AdvancedGenPanel.tsx:1182,1203`, `frontend/src/state/generateParamsStore.ts:236`
- [ ] **`thedaw:set-left-panel` has three dispatchers and no listener.** This is also the root cause of LEARN's "Open lineage rooted here" / "Open in Library" no-ops (they dispatch this event), and the assistant reports success anyway. Fix once in `Shell`/library-rail state. — XS — `frontend/src/orb-kit/actionHandlers.ts:157,161`, `frontend/src/components/library/LineageModal.tsx:3320-3356`
- [ ] **Assistant quick-commands advertise features that do not exist** ("Trending", "Full Sync", "discovery radio"). Emojis were removed in the de-icon sweep; the labels stayed. — XS — `frontend/src/orb-kit/AssistantPanel.tsx:65-77`
- [ ] **TRAIN button + `trainingStore` front a hard 501.** `ProcessingLog` reads `isTraining` and calls `triggerTraining`, which POSTs to `train_lora_stub`; 6 of 9 store actions have no caller. Either hide TRAIN until LoRA training exists (see P2) or point it at the Underfit sidecar. — S — `frontend/src/state/trainingStore.ts:105`, `frontend/src/components/layout/ProcessingLog.tsx:362,428`, `backend/server.py:2273`

### Wrong output

- [ ] **MIX: the rack is applied twice to the processed output you audition.** Unverified since the audit. — S — `frontend/src/views/MixView.tsx`
- [ ] `[verify]` **MIX: "Send to Edit".** Now fetches the output blob, loads it into `playerStore`, and switches to EDIT; whether EDIT's mount picks that buffer up as a clip is unverified. — XS — `frontend/src/views/MixView.tsx:1357`, `frontend/src/components/audio/WaveformEditor.tsx:82`
- [ ] **Library: bulk "Download → MIDI" always 404s** — still builds `/api/midi/file/${entry.id}` from the library-entry id; the per-row path correctly uses the midi row id. — S — `frontend/src/views/LibraryView.tsx:1322` (correct form: `:1969`)
- [ ] **LEARN: the Track tab fetches a 4-hop lineage and renders 1 hop.** Unverified since the audit. — M — `frontend/src/components/library/LineageModal.tsx`
- [ ] **MAKE: the seed actually used is never captured** — `seed: int = Form(-1)`, filenames emit `seed_-1`, metadata records `-1`. — M — `backend/server.py:488,1581,2027`
- [ ] `[verify]` **DJ: transport pads live during decode.** A `pendingPlayRef` now defers PLAY until `hasBuffer && !decoding`; confirm the first press lands. — XS — `frontend/src/views/DJView.tsx:654`
- [ ] **MAKE: `RF-Inv` is an exposed option that guarantees a 501.** Downgraded: the 501 now carries a plain-language explanation. Decision needed — hide the option, or implement RF-Inversion. — S (hide) / L (implement) — `backend/server.py:418`, `frontend/src/components/ui/tooltips.ts:30`

### Sway / VJ

- [ ] **The Sway DAW-control mirror arbitrates nothing** — one pad fires theDAW's synth AND the cockpit; auto-enabled for exactly this hardware. Code moved since the audit; behaviour unverified. — S — `frontend/src/App.tsx:295,349`, `frontend/src/components/sway/SwayLinkPanel.tsx:343`
- [ ] **While VJ is popped out every inbound message is discarded** — `isFromVj` accepts only the in-tab iframe's `contentWindow`, never `poppedWindowRef`. Confirmed. — S — `frontend/src/views/VJView.tsx:224,215`
- [ ] `[verify]` **SWAY "Input device".** SwayView now tells the cockpit to open its own input device in that mode; confirm visuals follow the mic rather than the internal groove. — XS — `frontend/src/views/SwayView.tsx:231,339`

## P1 — Ableton import (remaining)

- [ ] `[partial]` **MIDI notes are not rebased onto the loop window, looped regions never expanded.** `LoopStart` is now read and applied as the source offset; region expansion (8 bars over a 1-bar loop) is still not done. — M — `backend/modules/dawimport/ableton.py:589-624`
- [ ] **`<Disabled>` clips are unread** — a deactivated clip will sound. No reference in the parser. — XS — `backend/modules/dawimport/ableton.py`
- [ ] **Group tracks are dropped with no warning**; only device-rack groups are handled. — S (warning) / M (support) — `backend/modules/dawimport/ableton.py:110-131`
- [ ] **Sends / returns**: `send_amounts` exists only on the model — zero producers, zero consumers. Every imported mix is dry. — L (needs a bus model) — `backend/modules/project/tasmo_project.py:104`
- [ ] `[partial]` **Nested device parameters.** Rack containers are now flattened into first-class chain entries; VST/AU params and the 12-param cap are unverified. — S — `backend/modules/dawimport/ableton.py:135,876,921,943`
- [ ] `[verify]` **Device parameter names are never translated** — `translateDawParams` now re-keys Ableton names onto rack keys (per-effect and generic aliases, ms→s for reverb decay, clamped to the descriptor). Verify an imported Compressor lands at its source Threshold/Ratio. — `frontend/src/lib/dawEffectMap.ts`
- [ ] **Live Library / Pack sample refs are unresolvable** — `RelativePathType`, `SearchHint`, CRC all unread. — M
- [ ] **`media_status` on `DawClip`** — not present; `resolve_audio` still returns one shape for hit and miss. — M — `backend/modules/dawimport/media.py`
- [ ] **Automation envelopes and tempo map** — zero grep hits. Tempo automation is the dangerous subset. — XL
- [ ] **No `.als` fixture in the test suite** — coverage is still `assert callable(parse_als)`. — M — `tests/test_vst_daw_tasmo.py:153-156`

## P1 — EDIT (remaining)

- [ ] **`.tasmo` still drops automation lanes, master FX and master VST chains** — `tasmoToSession` hardcodes `locators: []`; nothing writes automation on save. — M — `frontend/src/lib/tasmoToSession.ts:94`
- [ ] `[partial]` **Export is one hardcoded 16-bit WAV.** The delivery backend is now reachable as EDIT *tools* (codec matrix, smart export, SRC, dither, metadata, batch) but the Export button still calls `encodeWav`, and `renderRange()` is still inside `commitEdit` — the prerequisite for stem export and region-regenerate. — M — `frontend/src/components/audio/WaveformEditor.tsx:2099,2306`, `frontend/src/components/audio/effects/editToolStack.ts:64`
- [ ] **Live MIDI reverb/chorus still bypasses the track chain** — output 0 is a shared effects bus. — M
- [ ] **Automation lanes can only be born by riding a control with WRITE armed**; no curve shapes, no hold. — M
- [ ] `[partial]` **No per-track metering or master fader in EDIT.** LEVELS now has a full master meter bridge (dBFS, LUFS, true peak, correlation — 2026-09-02); per-track meters and an EDIT master fader are still absent. — M — `frontend/src/components/audio/levels/LevelsPanel.tsx`

## P2 — larger builds

- [ ] **Tempo map and time-signature model.** BPM + tap tempo shipped; no time-signature or tempo-map field on `editorStore`. — M–L — `frontend/src/state/editorStore.ts`
- [ ] **Buses**: sends, returns, groups, sidechain. `liveMixer` hard-codes every track's destination. — XL
- [ ] **Recording at the playhead**: `armed` exists on the track type; no punch, takes, or armed-target recording. — XL — `frontend/src/state/editorStore.ts:125,257`
- [ ] **Marquee / time-range selection and ripple edit.** — L
- [ ] **LoRA training endpoints are hard 501 stubs behind a live TRAIN button**; real training only exists in the vendored Underfit sidecar. Pairs with the TRAIN item above. — M — `backend/server.py:2273`
- [ ] **Underfit's upstream updater is fully implemented in the backend with zero frontend callers.** — S — `backend/modules/underfit/router.py:72,78`

## P2 — frontier (uniquely enabled by the resident model)

- [ ] **Generative extend / continue** — `CAUSAL_MASK` is a trained mask type and the server accepts `inpaint_audio` + bounds; no frontend caller. — M
- [ ] **Clip variation ladder (SDEdit re-roll with a strength dial)** — `init_noise_level` is sent by MAKE only; EDIT sends neither. — M — `frontend/src/state/generateStore.ts:337`
- [ ] **SAME latent workspace** — `/api/autoencoder/encode`, `/decode`, `/api/jobs/pre-encode` remain 501 stubs. — L — `backend/server.py:2280-2296`
- [ ] **Non-destructive generative lineage** — `Clip.generation_prompt` / `generation_seed` / `generation_params` are still never written. — M

## P1 — added 2026-08-26 (second session), still open

(The Perform device-FX routing and theme-picker scrim items moved to the NOW
section above — coded 2026-09-06, awaiting a live check.)

## P2 — added 2026-08-26 (second session), still open

- [ ] **Boot: sequence the emergence** — no commits to either file since 2026-08-27. — S — `frontend/src/components/layout/LiquidChromeTitle.tsx:200`, `frontend/src/components/layout/LoadingScreen.tsx:78`

## Deliberately not doing

Recorded so they are not re-proposed:

- Full plugin delay compensation — no lookahead processor exists in the rack; VST3 cannot run live.
- MIDI clock / Ableton Link / MTC — no hardware-sync workflow in the app; Link has no browser implementation.
- Take lanes / comping — needs non-uniform per-track heights, which `editorStore` documents as a deliberate deferral.
- Real-time multiplayer CRDT editing — gated on the asset layer, and EDIT unmounts on tab switch.
- Neural restoration marketed as such — SA3 is not a super-resolution model.
- A bespoke export/encode DSP layer — `/api/edit/delivery` and `/api/convert/file` already do this properly.
- **Sway `sway/visibility`** (retired 2026-09-06) — the staged bundle handles it and `SwayView` pushes it; the original claim was stale.

---

## Removed this revision — to be logged in CHANGELOG (approval needed)

All merged to `main` between 2026-08-31 and 2026-09-05 (`facb78a`, `57f7863`,
`10310f1`, `62990e8`, `3ada4c3`, `39ac5e6`).

P0: footer button keyed on the real tab (`activeView` cluster) · `navigate('train')` no longer bricks CREATE · assistant approval stack live (T2 tools park as `pendingAction`).
P1 feedback: MAKE empty-prompt error rendered (`AdvancedGenPanel.tsx:455`) · Magenta setup gate rebuilt, dict `detail` unwrapped (`drawEngine.ts:675`) · Underfit 503 detail rendered · Settings PATCH rolls back + notice.
P1 dead controls: "Send to DJ" `pendingStart` consumed (`DJView.tsx:933`) · assistant `navigateTo` reaches all 12 workspaces · Media bucket "Send to INIT" → `make`.
P1 wrong output: NodeF.I. Effect node 400 · NodeF.I. wires deletable · Underfit port from `diag.port`.
Ableton: `performRouting` hydrated on both load paths (ccMods included).
P2: OPFS autosave + crash recovery · stems-on-a-clip → tracks · agentic `editor_*` vocabulary (12 tools).
Second session: NodeF.I. cursor offset · NodeF.I. node-editor toolset · lower-panel toggles (superseded by the footer action button) · `.swayproj` import · Sway deck factory map (`DECK_FACTORY`).

## Session journals to relocate (approval needed)

Lines 153–619 of the old file — the twelve "implemented, awaiting verification"
/ "verified live" blocks from 2026-08-26 through 2026-08-28 — belong in
CHANGELOG under their dates. Everything in them has since been merged; the
CHANGELOG currently ends at 2026-08-27.

## Landed since 2026-08-28 and recorded nowhere

Neither this file nor CHANGELOG mentions any of it. Each line is a CHANGELOG entry.

- 2026-08-31 — DJ prepared performance sets: timeline automix + assistant control (`019f7e9`, PR #140).
- 2026-09-02 — One-screen Settings, six-state Magenta engine gate, Lyria install, one-click Magenta install, HF token field (`3ada4c3`, `97c5731`).
- 2026-09-02 — LEVELS meter bridge (`ef9c1d7`); a real control panel for every effect, rack entry and tool, BACKLOG FX-001 closed (`3a72507`); collapsible MIX viz rack (`d20d5a0`).
- 2026-09-02 — Onboarding: Chimera DNA splice fixed, one-screen HOME, guided TOUR (`7926228`); showcase capture attach mode (`a2e7a7a`).
- 2026-09-03 — GPU telemetry reports every device (`398ba59`).
- 2026-09-04 — Chimera v2 phrase engine + seam healing (`299fcf4`); SCORE play-along modes, percussion notation, drum transcription, chord track, Beat Saber export (`fae1180`); flash-attention capability gate for Turing GPUs (`f73dd17`); width/height-aware shell scale + Tour rewrite (`660f0bf`); v0.1.4 (`715dddd`).
- 2026-09-05 — SING tab with whisper alignment, stems-first vocals, language picker (`b9a2b94`, `00db96a`); SCORE NOW/INK/TRAIL prefs, kept-alive views (`cb9429b`, `eb14d8f`); one pipeline coordinator for stems/MIDI/lyrics (`7e5beb3`); README how-to rewrite (`ada5431`, `4e58894`); SING guide + DJ prepared sets docs (`bb43620`).
