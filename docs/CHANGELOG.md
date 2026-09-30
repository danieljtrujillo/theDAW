# Changelog

Shipped and verified work. An item lands here when it leaves
[IN-THE-WORKS.md](IN-THE-WORKS.md) — the user called it done, or it was verified
by build, test, or observed behaviour.

Newest first.

## 2026-09-25

### DJ: a real way to start a set, and cue points that are already there (commits 9201efb, 7713d42; verified by tests: djCueSeed.test.ts, djRhythmStore.test.ts, DJView.dj3.test.ts)

- **START AUTO DJ** sits in the DJ header above the decks. When it cannot start
  it says what is missing in its tooltip — "Create a set first — click to make
  one", "Pick a set below", "Add at least 2 tracks to this set" — and the
  accessible name a screen reader reads carries the same reason in its own
  wording, instead of the Automix chip silently un-toggling itself. The button is
  never disabled in the DOM (that would take its tooltip and its tab stop with
  it); it is marked `aria-disabled` only where the press cannot change anything,
  and with no sets at all the press creates the set it is asking for. While a mix runs it reads STOP AUTO DJ, which stops the sequencer and
  leaves the decks playing.
- A bundled performance set is registered first and then started, by the header
  button and the Sets row's ▶ alike, so a full set no longer looks empty until
  something has clicked it. One shared count backs the button, the row and the
  sequencer, so they cannot disagree.
- Sets rows show an **ACTIVE** badge on the set automix actually reads (after a
  Send to DJ that is not the set you last opened), a spinner while their tracks
  register, and a ▶ that auto-DJs the set.
- A three-line hint sits over the decks until one holds a track: pick a set,
  press START AUTO DJ, or drag a track onto a deck.
- **Hot cues are seeded from the analysis**: the first downbeat, then the 16,
  32 and 48-bar phrase starts after it, with markers on the waveform. Cues you
  set or clear are never overwritten, and a phrase past the end of a short
  track leaves its pad empty instead of stacking a second marker on the end.
- Real bar lines come from the rhythm module's cache, read-only — the DJ tab
  never starts a rhythm run of its own. Run the Rhythm analysis on a track and
  the beatgrid, the cue seeding and the automix phrase alignment pick it up on
  the next deck load.

### DJ: automix that actually mixes (commits 889c4d9, 7cd2707; verified by tests: djAutomixPlan.test.ts, DJView.b12.test.ts)

- **One bassline at a time.** The outgoing low band is handed over to the
  incoming one across the middle third of the blend, relative to your own EQ.
- **Blends start on the phrase.** The mix-out point is quantised down to a
  16-beat phrase line of the outgoing track, from real downbeats when the
  rhythm cache has them and the beatgrid otherwise.
- **Honest beatmatch messages.** A tempo the pitch fader cannot reach is said
  out loud ("NOT beatmatched", "mixing unmatched") instead of the fader being
  parked at its limit under a "BPM Sync" label. Half and double time still
  count as a match.
- **Phase is corrected by bending the platter**, not by restarting the track,
  so the incoming deck no longer stutters as it comes in; what a bend could not
  deliver in one window is carried to the next tick. Sync-lock is held for the
  whole blend and released on the swap, so two decks cannot drift apart over a
  ten-second fade. Key-lock engages when the match needed a real pitch pull.
- **No dead air**, and no fader stranded mid-fade: an outgoing track that ends
  early starts the next one at once, and the crossfader always lands exactly on
  the incoming deck. The first track of a set starts on its first beat with a
  grid.
- **A key clash straight ahead is skipped** for the nearest harmonically
  compatible track when at least three tracks remain; strict set order
  otherwise, and an unanalysed track is never skipped over.
- A track shorter than the 18-second blend tail mixes out from its midpoint
  instead of the instant it starts, and a deck that never finishes loading
  stops automix after 15 seconds with "Deck A never finished loading" rather
  than polling for the rest of the session.

### DJ: automix waits for a deck that has not started (commit 5fb90a9; verified by tests: djAutomixPlan.test.ts, DJView.b12.test.ts)

- A deck that is still decoding no longer reads as dead air. START AUTO DJ used
  to load a deck and then "rescue" the set into the next track every half
  second while it decoded — a new track every few seconds, and nothing ever
  played. Only a deck that has actually made a sound can be rescued.
- A tempo match the pitch range cannot reach now pulls nothing: the pitch stays
  at 0 % with no key-lock and no phase nudge, instead of both faders sitting at
  their rails at the wrong speed while the message said "NOT beatmatched".
- Turning Automix on with a loaded-but-paused deck starts that deck (crossfader
  normalised, first beat) instead of waiting silently for a manual play.

### DJ: decks decode once and the waveforms analyse off the main thread (commits cc206b2, dfaedbe, 70b92eb; verified by tests: djAudioCache.test.ts, djSemanticWaveformAnalysis.worker.test.ts, djSemanticWaveformAnalysis.cost.test.ts, DJSemanticWaveform.b12.test.ts, DJSemanticWaveform.perf.test.tsx)

- Loading a deck fetched and decoded the same file three times and analysed its
  waveform on the main thread. Now each file is fetched and decoded once per
  sample rate, shared by every waveform and the engine, and kept in a
  four-buffer cache — decoded audio is large, so the cache holds two decks plus
  one either side of a transition. Decoding no longer opens throwaway output
  devices.
- Waveform analysis runs in a Worker, sized to the lane's real width and
  memoised, and rendered waveforms are cached offscreen at the app's actual
  zoom geometry. Measured on a 210-second stereo track across the four waveform
  instances a deck load mounts: 644.5 ms of main-thread work before, 41.8 ms
  after — the "lags super bad at the beginning".
- Library audio is served with a long `Cache-Control: private, max-age`, so a
  deck reload does not pull the whole file down again; it is deliberately not
  `immutable`, because the transcode cache for browser-unplayable containers is
  re-done when a source file is replaced. That cache (`data/playable-cache/`)
  is runtime data and is now ignored by git.

### Analysis: a DJ profile, a concurrency cap, and a BPM confidence (commits 86dafd0, 980889e; verified by tests: tests/test_analysis.py, tests/test_analysis_concurrency.py, tests/test_library_endpoints.py, djAnalysisStore.test.ts)

- A cache-miss analysis took 10-20 seconds per track. `?profile=dj` runs only
  what a deck reads — tempo, beats, confidence, key, RMS — and skips the pitch
  statistics and the second full-rate decode that loudness needs: about 2-3
  seconds instead of 10. The DJ tab uses it for everything it analyses.
- A partial row says so. The stored analysis and `GET /api/analysis/{id}` carry
  the profile that wrote them, so a partial row can no longer be read as a
  complete one whose expensive fields happen to be empty; a later full run
  completes it. A run that fails to measure something falls back to the stored
  values rather than erasing them, so a re-run whose tempo step fails cannot
  wipe a measured BPM.
- **`bpm_confidence`** (0 to 1) is kept now instead of thrown away. It is
  persisted with the analysis and carried on the deck’s analysis row, so a BPM
  detected at 0.1 confidence can be told apart from a solid one; no view renders
  it differently yet.
- At most two analyses run at once in the whole backend process, and callers
  asking for the same entry and profile join the run in flight. The cap sits on
  the analysis itself, so the library's background auto-analysis shares it
  instead of walking past it.
- The DJ tab's queue puts deck loads first and never drops them, while the
  browsing sweep is a replaceable window of at most 24 rows ranked decks →
  active set → visible rows, so scrolling re-aims it instead of building a
  backlog. A failing row is retried after 60 s, then after 120 s, and is given up
  on at the third failure — loading it onto a deck runs it anyway; the whole queue
  can be paused and resumed.

## 2026-09-22

### Listing performance sets no longer writes to the library (verified by tests: tests/test_library_setlists.py, tests/test_library_api_at_scale.py)

- `GET /api/library/setlists` registered every unregistered track of every performance set as a library entry and
  rewrote a sidecar on each read (25 commits per listing on a three-set folder). Listing is read-only; a set is
  registered once when it is opened, through `POST /api/library/setlists/{id}/register` (cross-site refused, 404 on
  an unknown id, no id echoed).
- Registering fills entry ids into the user's own list, matched by file name, so reorders, removals and hand-added
  tracks survive; it is not counted as an edit. Two overlapping opens register each file once: the store reuses the
  entry an identical resolved path already has, and the route holds a per-folder lock.
- A set's id hashes its files rather than its registrations, so it survives registration; bundled sets already in a
  browser re-import once under the new id.
- The API scale guard now points `theDAW_DATA_DIR` into its fixture, so its probes never read the developer's own
  data tree; a test pins that.

### Media roots: the library serves files it never owned (verified by tests: tests/test_library_media_roots.py)

- An entry whose audio was never written under `data/generations/` is served
  from your own media folders. `theDAW_MEDIA_ROOTS` names them and wins
  outright; otherwise Settings → Storage → Media roots does. One background
  scan indexes every file whose name carries the entry's full id, or its first
  eight hex digits in brackets right before the extension.
- The file is referenced in place. Nothing is copied into the entry, its
  metadata is not touched, and the roots are asked after the entry's own folder
  and before any remote copy.
- The Settings panel reports the index and rescans on demand. A root must be an
  absolute folder that exists and may not sit inside another root; one refused
  from the environment variable is logged and dropped, and the rest still index.
- The routes and the settings keys answer only to this machine. A LAN caller
  reads "Hidden on this device" in place of the folder list and cannot set it.
- When served from a media root, AIFF, WMA and APE are remuxed to WAV once
  for the browser and cached under `data/playable-cache/<id>/` instead of
  beside your file; an entry's own audio still remuxes into its entry folder's
  `_playable/`.

### LEARN: every number on the landing page opens a list (verified by tests: tests/test_lineagescale_explore.py)

- Songs with lineage and songs without, any relationship kind as parent, child
  or either end with the per-song count, rankings for any kind in either role,
  families by size and the members of one family — each of them a list now,
  searchable, sortable and paged at 50 rows.
- A row badges the provider and carries Focus and Copy id. Search reuses the
  library's own search tokeniser, over titles. A mashup cluster is counted apart: it is not a family.

### LEARN: the classic graph of one song, in the tab (verified by tests: LineageScaleView.test.tsx, LearnHost.test.tsx)

- **Classic graph** opens the classic view on the song in focus, inside LEARN,
  on a library far too large for the whole-library drawing. The Genealogy and
  3D tabs stay refused there and say why.
- The family is capped at 600 nodes, with a bounded number of relation rows per
  hop, and the cut takes from the far edge. When it bites the view says
  "Showing the nearest N of a larger family."

## 2026-09-15

### Magenta RealTime 2 loads on one card (verified by build + tests; measured on a 2080 Ti)

- **bf16 parameters.** `mrt2_base` was loading its parameters in fp32 and
  asking JAX for 75% of the card up front, which put it out of reach of an
  11 GB card whatever else was running. The loader now converts to bf16 and
  takes no arena up front: 4.68 GiB resident, about 0.8x realtime on one
  2080 Ti.
- **A load that runs out of memory retries** with a growing arena instead of
  dying, and the failure message measures the card rather than repeating the
  allocator's error.
- **A model one card cannot hold splits across every GPU in the machine.**
  Two cards hold it at 2.38 GiB each, at 0.33x realtime.

### The boot screen (verified by build; live check pending)

- The particle sequence *is* the boot screen. Particles gather into the
  wordmark, and the GANTASMO credit lands once the word has formed.

### Footer and status

- **TRAIN starts a run from the last run's settings**, so the footer action
  key does something when nothing is in flight.
- **A pitch bend lane** under the piano roll, with a semitone range and LINE,
  HOLD and CURVE point shapes: a bend can be drawn as well as played.
- **The action keys are their word and the transport is its icons.** IMPORT
  and Recent keep their own.
- A status notice sits against the orb and never covers the scrub strip.
  ArrowUp on the track menu key lands on the last row.
- MASTER FX, METAMORPH and the automation lanes open under their own keys.
- ffprobe output is read as UTF-8, so a song with an accent in its tags
  analyses instead of failing on the decode.

## 2026-09-14

### Every status message reaches the LOG and the orb (verified by tests)

- Status notices go to the processing log **and** the assistant orb's speech
  bubble, so nothing that happens is only visible for a second.
- Backend `WARNING` lines count as warnings, not errors, in the log's
  errors-only filter. A MIDI conversion reports progress instead of sitting
  silent for the 94 seconds basic-pitch takes to load.

### The MIDI dock (verified by tests; live check pending)

- An icon rail with `DockTip` hover labels, 12px text, a 34px settings strip
  and a 36px SHAPE row.
- Pitch bend in the roll model, in MIDI import and export, in playback, in
  the arpeggiator and in Vocal2MIDI.
- The three-dots footer key opens every audio action for the loaded track,
  grouped, with a row per stem.
- The song box lists library songs, so MATCH can pick one.

### Notation

- Notes read from a MIDI file stay at the second they sound.
- A band score lays every stem out on the song's beat grid.
- Sheets print the tempo as a whole number and still play the measured tempo.
- opus, mp3, flac, m4a and float WAV reach aubio and read the tempo a PCM WAV
  reads.

### Contrast

- Context-menu titles, headers and hints read on every theme.
- The rhyme web, section heads and SING export menu are opaque on every theme.
- The `?` search finds METER MAP, METER, STUDY, WEB, the Asset Library,
  Inputs & outputs and the EXPORT menu.
- A lane with no FX chain keeps one stable empty chain, so the EDIT rack
  opens on MIDI lanes.

## 2026-09-13

### The piano roll grows a meter map (verified by build + tests)

- **A meter map per roll**: a time signature that changes across one piece,
  additive groupings (`7/8 = 2+2+3`), bar arithmetic, MIDI signature events,
  and a pickup bar before the first full bar.
- **Polymeter lanes**, each with its own meter, denominator and loop length
  against the same clock.
- **MATCH** pulls a song's meter map, tempo and lanes out of its rhythm
  analysis. **GEN** writes LOOM's generators, gates, swing and accel as
  piano-roll notes. The METER face on the SHAPE row edits a meter per song
  section.
- Virtuoso transforms follow the meter map, with SYNC and ACCENT alongside
  them. The rhythm engine's metrical weights and syncopation scores draw on
  the grid.
- Meters and lanes survive a bounce to EDIT, a reopen in the roll, and a
  project save. Meter writes and length edits end the roll on a bar line, and
  a short import or a clip load never leaves it mid-bar.
- One settings strip, a left action rail, and the SHAPE row under the roll.

### theDAW remembers the paths it writes (verified by build + tests)

- Every path the app installs, saves, downloads or opens is registered.
  Pickers open where that kind of file last went, a Recent list hands the
  file back, and Show in Folder opens the file manager. Saving goes through
  the native Save As dialog.
- **Serving is vouched for**: only files theDAW registered are served, saves
  are granted by nonce, the launch token stays out of child processes, and
  theDAW's own folders stay out of the user's pickers. Model folders open
  without the token and `uv sync` stays off it.

### SWAY

- Custom scenes first, no icon before the wordmark, and one header when the
  cockpit is carrying theDAW's controls.
- Gantasmo songs first, the **Audima Labs Sway** by name, Orbitron and bold
  sans, and no bundle patches.
- The Will I Dream template plays theDAW's own shipped copy of its song.
- The VJ and SWAY embed builds revalidate on every load, so a restaged
  cockpit reaches a browser that cached the old one.

### One play key

- A single play key leads EDIT, PERFORM, LOOM, NODEFI, MIX, MAKE, the effect
  bar, SEQUENCE, SCORE, SING and DETAILS, always first at the left.
- Download and more sit before the volume, Fullscreen moved to the top bar,
  and the assistant stays pinned bottom-left until its first click.
- The assistant's sign is Orbitron at 12px.

## 2026-09-12

### An asset library (verified by build + tests)

- A searchable library of downloadable projects, plugins, volumetric captures
  and cockpit scenes, each with one button that installs it and opens it.
- The lineage graphs fill the LEARN panel at every window scale.

### One global input and output menu

- Six global slots for audio, MIDI and visuals, with per-surface overrides.
- A key icon on every field that takes a key. A Sponsor row in the app menu,
  and GitHub's own funding button.

### Files reach every surface

- Audio dropped from the desktop lands wherever a library track can be
  dropped. Right-click a lane in EDIT to add audio or MIDI from the library
  or from a file. Import a folder from the toolbar.
- The DETAILS right column is the full library and takes desktop drops.
  METER MAP runs the rhythm engine on a song on demand and exports the result.
- One shared sort order across the library, a drop intent for library lists,
  and three repeat modes.
- SCORE exports any part to any format, from either engraver.

### Diagnosis instead of a status code

- The failing hop is named for model status, SWAY, VJ, the Hugging Face hub
  and the microphone, in place of `HTTP 502` and bare errnos. Port preflight
  says which program holds port 8600.
- The backend is reached at `127.0.0.1`, never `localhost`.
- The Foundry pads stay out of an isolated renderer in every runtime.
  Plugin runtimes publish atomically and the bundled plugins build on first
  start; the Owl ships its artwork.
- The desktop app installs to Program Files and still starts, and relocating
  the writable data tree moves all of it, not just the library.
- The frontend test runner discovers every suite instead of chaining them by
  hand. Nine suites had been orphaned by the hand-maintained chain.
- **v0.1.8 and v0.1.9** released.

## 2026-09-11

### Meter maps for metamorphic meter (verified by 26 tests)

- The rhythm engine reads a time signature per segment, tempo curves with
  change points, per-bar syncopation and swing, polymeter per layer and
  cross-rhythms, at the tatum rather than the beat.

### The footer redesign

- The scrub strip along the top edge, a smaller play disc, one uncramped row,
  a matte transport plate and an uncovered PANELS strip.
- The orb loses its disc; footer keys and CREATE take the theme's accent.
- One global IMPORT button in the header, on every tab.
- One EXPORT menu in SCORE replaces the toolbar's row of export buttons. PDF
  is OSMD-only, Space activates the links, the hint is live, and focus
  returns where it came from.
- `.gan` artwork reopens from the archive, and bundles are written
  atomically.

## 2026-09-07

### LOOM v3 — colony mode (verified by build + tests; live check pending)

- **Cells, not lanes.** A PLANE | COLONY switch; colony scores are graphs of
  `loop`, `rule`, `gate`, `mod` and nested `colony` cells joined by arrows.
  Colonies carry their own meter (`7/8 groups=3+2+2`, `11/8`, `5/4`) and
  tempo, and nest without limit. Living canvas: membranes, step rings,
  sparks, slime-mould trails; dive into a colony with a double-click.
- **Silence fixed**: a role with no stem plays the mix at once and asks for
  stems; shards re-read and scores re-resolve when they land. Stem loops of
  2 and 4 bars (`{role=drums beats=8}`).
- Sample *Inca Roads — colonies in 7/8, 11/8 and 5/4*.

### LOOM v2 — rules, growth, a tempo that moves (verified by build + tests; live check pending)

- **Generator tiles.** `fib`, `fractal` (thue / cantor / dragon /
  sierpinski), `euclid`, `life`, `rand`, `frag`, `echo`, `accel`, `gliss` as
  `name(alphabet; opts):span` rail tiles; upper-row generators modulate the
  column below. Ghost cells draw what a rule plays this lap. Every die roll
  hashes (seed, lane, step, lap).
- **Directives** `seed`, `form AABA` (Life replays a section's generation),
  `ramp bpm FROM TO LAPS` (phase-preserving at the master wrap).
- **GROW pane**: Grow, Breed, Fragment, seed, form, lineage with revert,
  per-lane keep. Sample *Garden of Forking Beats*. Woven surface, threaded
  tiles, breathing live column.
- **DETAILS + Media merged** into one lower-panel tab with a Details / Both /
  Media layout toggle; the library opens details from a hover button and the
  context menu; import-from-link (YouTube, SoundCloud, Bandcamp, direct URL)
  lives in the library header.

### In-app updater

- **Settings > Check for Updates now updates.** Check, confirm, install, in
  one dialog. Clones (theDAW.bat, theDAW.sh, Pinokio, dev Electron):
  `POST /api/updates/apply` pulls `main` fast-forward, refreshes the Magenta
  submodule and exits the backend with code 89; the supervisor and the dev
  stack run `uv sync --group dev` and `npm install` with no backend holding
  the venv, then respawn, and the page reconnects on its own. Packaged
  Windows app: electron-updater downloads the installer from the published
  release (progress in the dialog), quits and runs it. Packaged macOS app:
  downloads the new dmg (unsigned builds cannot self-update). Local edits in
  a clone block the pull with a 409 instead of being overwritten.
- `GET /api/updates/check` reports `install_kind`, `can_apply`,
  `restart_mode` and the release assets. The release workflow attaches
  `latest.yml` and the `.blockmap` next to the Windows installer.

## 2026-09-06

### Release

- **v0.1.5** — LOOM Phase 0, the Magenta GPU lane, stems resilience, the
  duotone themes and everything below. The release workflow now passes
  `SWAY_REPO_TOKEN` to the installer builds and fails fast when the secret is
  missing; that missing pass-through is why the v0.1.4 tag never produced
  installers. Pinokio launcher updated in lockstep.

### Open-issue triage (GH-127, 131, 132, 133, 134 and the Pinokio launcher issue)

- **Model downloads no longer die on the first byte under Pinokio.** The
  download progress class was a plain tqdm subclass, and huggingface_hub
  passes it a `name` kwarg only its own wrapper accepts; tqdm validates that
  only when stderr is a terminal, so Pinokio users saw
  `Unknown argument(s): {'name': 'huggingface_hub.http_get'}` while piped test
  runs never did. Now built on `huggingface_hub.utils.tqdm`, with a tty
  regression test.
- **Medium and small-sfx fall back to the public mirror** like small-music
  already did, and the Settings catalog recognises a mirror-populated cache
  instead of re-asking for a download that 403s (GH-133).
- **Underfit's missing-model dialog names the base checkpoint repo** and how to
  fetch it; "run the installer again" was wrong (GH-133). Underfit setup now
  installs the `stable_audio_3` backend into its venv (`uv sync` never did, so
  every launch ended in "run ./install.sh"), and Pillow plus the backend are
  part of the venv health check so Repair offers itself (GH-131).
- **EDIT inpaint raises the same fix cards as MAKE** (allow downloads, sign in,
  open the model page) when the model load is what failed; `/api/generate`
  returns the load error as a 502 with detail like `/api/generate-jobs`
  (GH-132).
- **Stems tooltip** says how to set Demucs up instead of printing the missing
  interpreter path (Pinokio launcher issue #1).
- **npm audit** fixes applied in `frontend/` and `electron-ui/` (23
  vulnerabilities cleared; every lockfile change verified upward). The
  deprecation warnings on install are transitive (`gl` under
  opensheetmusicdisplay, `@google/genai` 1.x, electron-builder's own tree).
- GH-134 (Linux) is answered by `theDAW.sh` and `docs/linux/setup-guide.md`;
  GH-127 (Flash Attention 3 wheels) does not apply: those kernels target
  Hopper/Blackwell datacenter parts and need torch 2.8.

### Queue re-check

- **IN-THE-WORKS re-verified against `main`.** All 75 open items were checked
  against the code; 22 were found done and merged and are retired here.
  - P0: the footer action button is keyed on the real tab (`activeView`
    cluster); `navigate('train')` can no longer brick CREATE; the assistant
    approval stack is live (T2 tools park as `pendingAction` and render the
    confirmation card).
  - Feedback: MAKE's empty-prompt error is rendered; the Magenta setup gate was
    rebuilt and dict `detail` payloads are unwrapped; Underfit's 503 diagnosis
    is rendered; a failed Settings PATCH rolls back and shows a notice.
  - Dead controls: "Send to DJ" automix handoff is consumed; assistant
    navigation reaches all 12 workspaces; Media bucket "Send to INIT" lands on
    MAKE.
  - Wrong output: NodeF.I. Effect node no longer 400s on first run; NodeF.I.
    wires are deletable; Underfit's dashboard URL derives from the live port.
  - Ableton: `performRouting` hydrates on both project-load paths, CcMods
    included.
  - P2 / frontier: OPFS autosave and crash recovery; stems-on-a-clip explode to
    tracks; the 12-tool `editor_*` assistant vocabulary with a real arrangement
    context.
  - Second session: NodeF.I. cursor offset; NodeF.I. node-editor toolset;
    lower-panel toggles (superseded by the footer action button); `.swayproj`
    import; Sway deck factory CC/note map.
- **Retired as stale:** "the staged SwayCommand build ignores `sway/visibility`"
  — the bundle handles it and SwayView pushes it.
- **Theme picker previews without a scrim** — the overlay no longer darkens
  the editor while a theme is chosen, so colours can be judged live. Last
  Tailwind v3 form in the tree (`z-[300]`) removed.
- **Twelve duotone themes** added to the picker (Navy & Gold, Charcoal & Amber,
  Forest & Cream, Burgundy & Rose, Slate & Copper, Ink & Cyan, Plum & Mint,
  Cocoa & Sand, Olive & Bone, Cream & Navy, Blush & Charcoal, Sage &
  Terracotta).

### Evening: Magenta GPU lane, stems resilience, LOOM samples (verified by build + tests; live check pending)

- **Magenta engine start waits its turn for the GPU.** Both bring-up paths take
  the pipeline's single GPU lane, so a Demucs / whisper / MIDI run can no longer
  sit on the card while JAX loads (the `RESOURCE_EXHAUSTED` failure from the
  full-suite pass). Status reports "waiting for the GPU" while queued; an error
  state carries a classified `error_kind` and a one-sentence `fix` that the
  Restart card shows.
- **Stems polling survives a dropped sidecar connection** (six retries with
  reconnect) and any remaining failure is a 503 with a cause, not an ASGI
  traceback.
- **LOOM**: uniform Jacquard-style square tiles with a step ruler and per-tile
  glyphs; rebuilt on theme tokens after the contrast audit found 58 light-theme
  text failures on the first cut; four sample scores (two simple, two involved)
  in the CODE pane; quoted values in query literals.

## 2026-09-05

### SING, SCORE, pipeline, docs

- **SING tab** — large centred lyrics, glide scroll, mismatch underlines, AUTO
  align; whisper alignment on the GPU, stems-first vocals, language picker.
- **SCORE** — NOW/INK look prefs, TRAIL hold/flash for the ink, centred strips,
  one layout per zoom, kept-alive views, smooth forward-only strip scroll.
- **Pipeline** — one coordinator for stems, MIDI and lyrics; forced-aligned
  lyrics; GPU everywhere.
- **Docs** — README how-to per tab; SING guide; play-along look settings;
  prepared DJ sets; pipeline scheduling.

## 2026-09-04

### Chimera v2, SCORE play-along, release

- **Chimera v2** — phrase engine, seam healing, and a CREATE that never stalls
  silently.
- **SCORE** — play-along modes, percussion notation, drum transcription, chord
  track, Beat Saber export.
- **Attention** — flash attention gated on GPU compute capability (Turing GPUs
  fall back cleanly).
- **Shell** — width- and height-aware scale; Tour view rewrite; control polish.
- **Library** — lyrics groundwork for SING.
- **Release** — v0.1.4; six stale test assertions caught up.

## 2026-09-03

- **Telemetry** — every GPU reported, not just `cuda:0`, with device-wide VRAM.

## 2026-09-02

### Settings, Levels, effects, onboarding

- **Settings** — one screen; six-state Magenta engine gate; real model list;
  Lyria install; one-click Magenta install; HF token field; real error text for
  gated models.
- **LEVELS** — a conventional meter bridge (dBFS ladder, LUFS tiles against
  target presets, true peak, correlation, balance, 60 s history) replacing the
  six icon-switched views.
- **Effects** — a real control panel for every effect, rack entry and tool;
  BACKLOG FX-001 closed. MIX viz rack collapsible, ARES controls on their art at
  first paint, one-shot `.gan` reveal; viz-row icon buttons labelled with
  pressed state.
- **Onboarding** — Chimera DNA splice fixed, tour rebuilt, one-screen HOME,
  guided TOUR.
- **Underfit** — dashboard no longer crashes on an empty seq-info table;
  diagnosis payloads without an issues array tolerated.
- **Showcase capture** — attach mode drives an already-open window and
  screen-records it; the film's cast comes from `showcase/_cast.json`.

## 2026-08-31

### DJ prepared sets, merges

- **DJ prepared performance sets** — automated timeline automix plus assistant
  control (PR #140); review fixes for automix and performance-set path handling.
- **Merged to main** — NodeF.I. rename and premium pass; slim bottom chrome;
  Underfit venv self-repair (a half-built venv is detected and repaired);
  inpaint model selection; POSIX dev stack; errors that were being discarded
  are now surfaced.
- **Sway** — a request body can no longer widen the media allowlist.

## 2026-08-28

### NodeF.I. tendrils, PERFORM rail (verified live)

- **NodeF.I. tendril controls** replace the SLIDE sliders — filament-under-
  tension ranged params, asymmetric cells for short selects; drag, wheel, keys,
  double-click reset, click-to-type. Type ramp raised everywhere.
- **PERFORM right rail** — ROUTES (filterable, grouped) and PARAMS (per-track
  device browser pushing tendril edits into the running chains). Default
  closed, drag-resizable, zero footprint when closed.

## 2026-08-27 (later passes)

### Issue triage #127 #131 #132 #133 #134

- Inpaint sends the selected model; MAKE inpaint refuses an empty region with a
  "drag a region" message; the model picker persists; HF sign-in card raised
  from gated download failures; Underfit venv probe, Repair vs Create, `log_tail`
  rendered, 503 detail rendered, port from `diag.port`; installer ships
  `underfit/`; Underfit model registry JSONs vendored; Linux launcher
  `theDAW.sh` + guide; flash-attention visibility in `/api/health`; five docs
  that were wrong corrected.

### Sway Perform, Kargyraa, NodeF.I. passes

- **PERFORM pads punch FX** (note-driven CcMods, momentary or `latch`); chain
  param pushes keep sibling params; new `kargyraa` subharmonic rack effect;
  `.tasmo` VST nodes stay inert in PERFORM; per-song templates regenerated.
- **Open-in-all-surfaces** — a project opens in EDIT and PERFORM from one load;
  grid-only projects land on PERFORM. Bottom chrome slimmed ~30 px.
- **NodeF.I. (then Audimate)** — premium pass (glass dock, goo rail, pull-a-
  node-out-of-the-goo), template patches, LIVE performance engine (Stem, Filter,
  VCA, Echo, Crossfade, LFO, Live Out, mod wires), Rack FX live node, one live
  set per song, square node rail, resizable rails, saved sets with export/
  import, Suno cloud node, inspector redesign, rename to NodeF.I.
- **Every-theme contrast** — translucent hex chrome surfaces remapped for light
  themes; hover and pale-accent text darkened. Verified on Porcelain.
- **De-icon / de-glow sweep** — icons only where they are the control;
  decorative LED dots removed. Footer owns the action button; per-frame tick
  isolated so the footer shell stops re-rendering at 60 Hz.
- **docs/guides/audimate.md** rewritten.

## 2026-08-26 (third session)

### The P0 cluster and the big builds (coded that day, merged 2026-08-31 → 09-04)

- `activeView` cluster, approval stack, agentic editor vocabulary, Media bucket
  "Send to INIT", OPFS autosave, NodeF.I. node-editor tools, footer-styled
  lower-panel toggles, `.swayproj` import, stems-on-a-clip explode, XR BUS
  tester moved to a dev-only dock tab, EDIT FX/ARES panels portaled and plugin
  windows detachable, unified effect control windows, SWAY tab track add/save/
  playback made real, Sway performance template + the `perform_routing.ccMods`
  persistence it exposed, note-by-note notation follow, EDIT toolbar
  decluttered.

## 2026-08-27

### Per-song Sway performance templates

- **Three per-song Perform sets authored and round-trip verified** —
  `Sway Perform - {Prologue,EACC,Just Give Up}.tasmo` in
  `Documents/theDAW Projects`, from the new `scripts/make_sway_song_templates.py`.
  Each: 6 stem columns, 26 looping clips, 29 devices, 8 scene pads, 29 pad-punch
  routes, 47 knob/XY routes, real analyzed tempo and key baked in. Verified by
  loading each file back through `TasmoFile.load` — clip count, route count,
  `latch` flags and VST state all survive. ("Prelude" resolved to the album's
  `01 - Prologue.wav`.)
- **Stems sidecar was dead on this machine and is fixed.** Its venv's
  `pyvenv.cfg` pointed at a base Python under a stale user profile, so every
  separation failed with a dependency-install error naming packages that were
  actually present. Re-pointed at the installed Python of the same minor
  version; 6-stem separations for Prologue and Just Give Up then completed
  through `POST /api/stems/{id}/run`, with every stem verified to match its
  master's duration and sample rate.

### Documentation sweep

- **New guide: [guides/sway-perform-live.md](guides/sway-perform-live.md)** and
  registered in the RAG index — the Perform grid, the SwayCommand deck and its
  factory CC/note map, scenes vs FX punches, the four routing layers that travel
  in a `.tasmo`, the shipped templates, and the Kargyraa Sub engine.
- **Corrected documentation that was actively wrong.** `USER_GUIDE` §16.10 still
  described SWAY as a camera-pose bottom-panel tab (it is the embedded
  SwayCommand cockpit); §35.3 described a generic routing panel (it is the
  SwayCommand deck); §7.7 advertised "six psychoacoustic processors" and a
  MASTER FX / `F` button pair that no longer exist (19 effects, one `FX` button,
  floating per-entry windows); §5 claimed nine center tabs; §16 claimed ten
  bottom tabs. The effects reference heading said 18 effects.
- **Documented shipped-but-invisible features** across the reference tree and
  guides: unified effect control windows, OPFS autosave and crash recovery,
  clip → stems explode, the 12 `editor_*` assistant tools and the T1/T2 approval
  tiers, all-workspace navigation, the NodeF.I. (formerly Audimate) node-editor toolset, note-by-note
  notation follow and the tab-timing migration, `.swayproj` import, the
  `/api/sway` route family, `POST /api/dawimport/sway`, and the `EffectChainNode`
  / `perform_routing` schema detail in the project guide.

## 2026-08-26

### Sway / Perform (second session)

- **A plugged-in Sway is seen by theDAW.** Master MIDI gate now defaults ON
  (persisted-store v2 migrate flips existing installs); theDAW holds the only
  `requestMIDIAccess()` and relays to the SwayCommand cockpit, so the old OFF
  default made hardware invisible here while standalone worked. Verified: relay
  traffic in the cockpit, playable.
- **SwayCommand embed splash tells the truth about MIDI.** Its `available`
  getter ignored relay mode and reported "WebMIDI unavailable" while relayed
  CCs played. Fixed in the staged bundle, re-applied on every
  `fetch:sway` (BUNDLE_PATCHES), and upstream in the SwayCommand source.
- **PERFORM auto-routes projects built for the Sway.** `.als` MIDI-learn
  mappings become direct CC→mix routes on load; dim-named mappings seed
  bindings; SwayCommand's factory CC map ships as overridable defaults
  (learned > project > factory). Verified against the DNB template (110
  mappings parsed, routes live, deck animating).
- **The SwayCommand deck is PERFORM's assignment surface** — verbatim port of
  `surface.js`, collapsible; pads→scenes (chromatic notes), knobs/XY/gestures→
  volume/mute/any live FX-chain param (`handle.updateParams`), buttons→
  transport by learn. SWAY tab reduced to the cockpit alone.
- **Perform header: icons only.** One Open (imports on pick/Enter/recent), one
  Save (.tasmo); detected-DAW, warnings and missing-samples are hover badges;
  the InfiNight credit is an info icon; footer strip removed.

### Boot, orb, capture (second session)

- **Boot cinematic**: full-window goo sheet + wordmark in the orb's exact
  wet-obsidian material (mirror stays a mirror — visibility comes from
  forward-hemisphere light angles and the bright room env on the sheet); the
  wordmark sinks into and rises out of the sheet; credits gated on formation
  (theDAW → by → GANTASMO). Verified by screenshot at three boot phases.
- **Orb**: 112px (−30%), all rings/halos gone, ferrofluid from the first
  visible frame (mounts post-boot), sticky bottom-left corner surviving
  resizes until first drag, ~2.4× slower idle cycles, footer tip bubble
  (operational tips, greeting dwell, never truncates, fixed width so the
  now-playing block stops jumping) replacing G-Search; Ctrl-K opens the
  library rail.
- **Capture harness**: video/wall-ratio slicing (fixes the one-scene-early
  drift on long takes), stamped per-run session files (a fixed name destroyed
  a finished take once), bounded + concurrent stem loading (285s→17s to first
  hold), `data-boot-splash` wait, monitor pinning + CDP fullscreen, six new
  tab scenes, driven TOUR map/routing. 67 clips reshot at 1920×1080.


### Ableton `.als` import

- **Imported projects can actually play.** No importer registered its project's
  media with `media_access`, so every clip fetch returned 403 and the Perform
  grid rendered correctly and played silence. Because media roots persist to
  disk, the same set was silent on a clean install and worked afterwards if any
  earlier save had touched that folder — the source of the "it's inconsistent"
  report. All nine importers now register the source folder and every clip path.
- **Saving from Perform no longer destroys the project file.** It wrote zero
  clips: `tasmoToSession` stamps a scene index on every clip and the save path
  filtered exactly those out (and `0 == null` is false, so even row 0 went).
- **`.tasmo` can represent a clip-launch grid.** Added scene/slot/track placement
  to `Clip` and a `scenes` list to `TasmoProject`; an 8×6 grid used to reload as
  an 8×1 "Scene 1" ladder. Legacy files still validate. The session-clip filter
  moved from save to load.
- **Session clips honour their trim, loop, and warp.** Length is now
  `CurrentEnd - CurrentStart` with the trim carried as an offset; `<Loop><LoopOn>`
  is read; `<IsWarped>` plus warp markers give the sample's own tempo so loops
  recorded at different BPMs stay together.
- **Live's colour palette is decoded** — the parser emitted the literal string
  `"index:26"`, which the grid ignored and the editor accepted as valid CSS.
- **Dead tempo XPath fixed.** The primary lookup missed in every real Live Set
  and time signature had no Live-12 `<MainTrack>` coverage, so a 6/8 project
  silently parsed as 4/4.
- **Frozen tracks no longer bleed into the arrangement** — an unscoped clip-slot
  walk reached `<FreezeSequencer>` and imported "FROZEN RENDER" as content.
- Solo parsing no longer depends on a falsy-Element footgun; MIDI velocity of
  exactly 1 is no longer inflated to 127; time signature, locators and source
  version now survive a save.

### Perform tab

- **Per-clip launch and per-track stop.** Every cell used to fire the whole row,
  so there was no way to hold a bassline while changing drums. Empty slots are
  stop buttons, as in Live.
- **Mute, solo and pan reach the audio graph** for the first time — there was no
  panner at all, and gain folded in only the Sway modulation mute. The S/M
  buttons now work and carry ARIA state.
- **Real launch quantization.** "1 Bar" was literal text while every launch fired
  immediately; the time signature was the literal "4 / 4".
- **Playback runs through the imported device chains** — the grid had zero device
  references, so an imported mix was completely dry. Metering moved post-FX.
- Missing samples are named instead of failing anonymously; an arrangement-only
  set explains itself instead of rendering a wall of dead cells; prefetch warms
  only launchable clips instead of decoding the whole project.

### EDIT tab

- **Clip add/delete no longer kills the transport.** `playEditorTimeline` closed
  over `clips.length`, so its identity changed on every edit and tore down the
  mixer mid-playback; `dispose()` never cleared `isPlaying`, leaving the footer
  stuck on Pause forever. The attach effect is now mount-only.
- **Trimmed clips survive a save.** `offset_into_source` was never persisted while
  the full untrimmed source was embedded, so a split vocal reloaded at the right
  position and length playing the wrong words.
- **Ctrl+D no longer corrupts the document** — duplicates reused the source clip's
  id, so two clips shared one id and every later update hit both.
- **Coordinate-space fix.** The shell applies CSS `zoom`, so pointer maths mixed
  viewport and local pixels: every seek, split point, loop edge, marker drop and
  drag read short, and clip drags picked the wrong lane.
- **Unsaved-changes guard**: a dirty flag, a `beforeunload` prompt and Ctrl+S.
- **Real pause** — Space and the transport button rewound to zero.
- **Per-clip gain**, applied identically live and in all three offline bounces,
  and persisted.
- **Editing additions**: clip clipboard, split at playhead, grid nudge,
  cross-track move, select-all, zoom-to-fit, follow-playhead, vertical zoom,
  a 13-division snap grid with triplets and dotted, BPM field and tap tempo,
  per-track VST3 inserts, and a `?` shortcut overlay.
- **LUFS meter reads the programme, not the monitor.** The listening fader was at
  the head of the graph, so turning the speakers down lowered the reading; it now
  sits last, with metering tapped post-FX and pre-monitor.
- **MIDI**: split clips no longer play the pattern twice; an instrument assigned
  after insert no longer plays one sound and exports another; live MIDI runs
  through the track's fader, pan, inserts and master rack instead of bypassing
  the mixer.
- Master VST freeze sends its captured plugin state instead of rendering at
  factory defaults; DAW-imported MIDI is no longer silent; empty-timeline clicks
  deselect; double-clicking a fader returns it to unity instead of silence;
  the delay's Mix control crossfades like every other wet/dry.
- `navigate('edit')` opens EDIT — it mapped to MIX, so the arrangement workspace
  was unreachable by name and the assistant could not open the tab it drives.

### SwayCommand

- **New SWAY tab** embedding the SwayCommand cockpit, served at `/sway-app` and
  shown in a same-origin iframe (cross-origin freezes its rAF transport clock
  when hidden).
- **Electron kept in lockstep**: main-process route, dev proxy, packaging
  resources, and `fetch:sway` wired into every dist chain — it was defined but
  never called, so a built installer would have shipped without the cockpit.
