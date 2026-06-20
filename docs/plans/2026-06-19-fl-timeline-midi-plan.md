# FL-Style Timeline: First-Class MIDI Clips — 2026-06-19

Evolve the editor toward an FL-Studio-style workflow: MIDI is first-class in the
timeline, editable in place, each clip/track plays through an assigned soundfont
instrument. Builds directly on I2.1 (soundfont engine) and the existing editor.

## What already exists (verified via architecture map)
- **Live transport** in `frontend/src/state/liveMixer.ts`: per-track gain +
  stereo panner nodes into `getMasterGain()`, clips scheduled as
  `AudioBufferSourceNode`s at the right offset, an rAF clock advancing
  `editorStore.playheadSec`, and click-free mid-playback fader updates.
- **Clip model** (`editorStore.ts`): `AudioClip.sourceKind: 'audio' | 'piano-roll'`
  already carries `sourcePianoRoll: PianoNote[]`, `sourceBpm`, `sourceTotalSteps`.
- **Round trip**: WaveformEditor right-click "Edit in Piano Roll" ->
  `pianoRollStore.loadFromClip` sets `editingClipId`; editing re-bounces via
  `updateClip`. So a timeline clip already opens in the Piano Roll and writes back.
- **Soundfont engine** (`soundfontEngine.ts`): `previewNoteSF`, offline render, and
  `useSoundfontStore` (active program). Render paths in `midiSynth.ts` delegate to it.
- Per-track mixing exists; there is no per-clip/track instrument assignment yet.

## Load-bearing decision: how MIDI clips sound during transport
- **Auto-bounce (recommended v1):** a MIDI clip stores notes + an instrumentId and
  keeps a cached rendered `audioBlob`. Editing notes or changing the instrument
  re-renders the clip through the soundfont engine (fast offline render of a short
  clip). Transport plays the cached audio through the existing `liveMixer`. Pros:
  reuses the sample-accurate scheduler unchanged, lowest risk, instrument changes
  are exact. Con: a short render after each edit (cached, only on change).
- **Live synth (later phase):** schedule `noteOn/noteOff` into the live
  SpessaSynth during transport via a lookahead scheduler. Pros: no re-render, true
  real-time. Con: SpessaSynth `noteOn` is immediate, so timing relies on a
  lookahead/setTimeout scheduler (not sample-accurate) and adds a parallel
  transport path. Best added after the auto-bounce UX is in.

Recommendation: ship the auto-bounce model first (FL-like UX without the live
scheduler risk), add the live-synth path as F5 only if edit-render latency feels wrong.

**DECISION (2026-06-19): user chose TRUE LIVE SYNTH from the start.** MIDI clips play
by scheduling `noteOn/noteOff` into the live SpessaSynth during transport via a
lookahead scheduler integrated with `liveMixer`. Notes map to a SpessaSynth channel
per track (program = the track/clip instrument); the offline export keeps using the
sample-accurate `startOfflineRender` path. Live-synth work moves into F1 (was F5).
v1 caveats to accept: lookahead/timer timing (not sample-accurate, fine for preview),
16-channel cap (16 simultaneous instruments), and per-track volume/pan not yet applied
to MIDI (mute/solo ARE honored by skipping scheduling); per-channel audio routing for
MIDI faders is F4.

## Phases
- **F1 — MIDI clip model + instrument assignment.** Add `instrumentId` to clips
  (and a per-track default) referencing a soundfont program ('basic' = sawtooth).
  Auto-re-bounce a clip through its instrument when notes or instrument change.
  Per-clip and per-track instrument pickers. Outcome: existing piano-roll clips
  play through their chosen instrument.
- **F2 — Inline note rendering.** Draw note rectangles over MIDI clips in the
  timeline (left = (noteStart-clipStart)*zoom, top by pitch), instead of (or with)
  the waveform peaks. Read-only first, so clips read as MIDI at a glance.
- **F3 — Inline editing.** Selecting a MIDI clip binds the Piano Roll to it
  (reuse `editingClipId`) with seamless write-back (auto-re-bounce on edit). Then
  basic in-clip note editing in the timeline (drag/move/draw) for short clips.
- **F4 — Channel rack + multi-track import.** A channel-rack-style instrument list;
  multi-track MIDI imports land as separate instrument tracks rather than one
  flattened part. Drum-channel-10 aware.
- **F5 — (optional) true live MIDI scheduling.** Lookahead scheduler driving
  SpessaSynth during transport, if auto-bounce latency is unsatisfactory.

## Integration seams (from the map)
- `editorStore.ts` AudioClip/EditorTrack: add `instrumentId?`.
- `liveMixer.ts` `scheduleClips`: MIDI clips keep playing as cached audio (no change
  in v1); F5 would add a `scheduleMidiClip` branch here.
- `WaveformEditor.tsx` ~1389-1514 (clip body) for inline notes; ~1619-1637 (context
  menu) for "Edit MIDI".
- `PianoRoll.tsx` re-bounce (235-303) + `pianoRollStore.editingClipId` for the bind.
- `soundfontEngine.ts` for per-clip render with a specific program.

## Progress
- **F1 live-playback core BUILT + typecheck-clean (needs audio verify).**
  `liveMixer` schedules MIDI clips' notes through the live SpessaSynth during
  transport (timer-aligned), skipping their bounced audio when live; gated on
  soundfont intent (global picker on, or a clip/track `instrumentProgram` set) so
  pure-audio users are unaffected; mute/solo honored; falls back to the bounce if
  the synth is not ready. `soundfontEngine` gained `liveNoteOn/liveNoteOff/`
  `liveAllNotesOff/isLiveSynthReady`; `editorStore` gained `instrumentProgram` on
  clip + track. Until a per-clip UI lands, timeline MIDI uses the global active
  program (set by the Piano Roll instrument picker).
- **Remaining:** per-clip/track instrument picker UI (F1b); inline note rendering
  (F2); inline editing bound to selection (F3); channel rack + multi-track import +
  per-track volume/pan routing for MIDI (F4); export-with-live-instruments (offline
  render still uses the clip's last bounce).

## Risks / gotchas
- Re-bounce latency on every edit: debounce + cache; only re-render on actual change.
- `editingClipId` can dangle if the linked clip is deleted (map flagged this) — clear
  it on clip removal.
- Multi-track MIDI is currently flattened on import (`loadMidiIntoPianoRoll`); F4 fixes
  this, F1-F3 stay single-part per clip.
- Live MIDI (F5) timing is not sample-accurate through SpessaSynth's immediate noteOn.

## Verification
Frontend audio + visual: the user's eyes and ears, never headless. Each phase ends
with a live check (a MIDI clip in the timeline shows notes, plays its instrument,
edits and re-hears) plus a typecheck. RAG doc updates are approval-based, proposed
once the feature is user-facing.
