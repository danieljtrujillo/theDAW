# Soundfonts + Custom-Instrument Builder (stems/MIDI Phase I2) — 2026-06-18

Give theDAW real instrument voices for MIDI/stems: full SoundFont2/SF3 playback
plus a layered custom-instrument builder. Successor to Phase I1 (play/delete/
favorite/route stems+MIDI, shared `midiSynth`).

## Locked decisions (user-chosen 2026-06-18)
- **Engine:** SpessaSynth (`spessasynth_lib` + `spessasynth_core`), a full
  SF2/SF3/SFOGG/DLS AudioWorklet synthesizer. FOSS.
- **Builder scope:** full layered builder (multi-layer instruments: soundfont
  preset / oscillator / sample, per-layer ADSR + filter, per-instrument FX).

## Why SpessaSynth works here (the load-bearing constraint)
Every MIDI->audio path funnels through `frontend/src/lib/midiSynth.ts` and must
run on BOTH a live `AudioContext` (piano-roll preview) and an
`OfflineAudioContext` (the WAV bounce used by `LibraryView`, `sendToTargets`,
PianoRoll). SpessaSynth supports both:
- Live: `new WorkletSynthesizer(ctx)` after `ctx.audioWorklet.addModule(processorUrl)`,
  then `noteOn/noteOff/programChange`.
- Offline: same on an `OfflineAudioContext`, `await synth.startOfflineRender({
  midiSequence, soundBankList })`, then `await ctx.startRendering()`. Our own
  oscillator/sample voices scheduled into the same offline destination render in
  the same pass, so layered instruments bounce correctly.

## Architecture
- New `frontend/src/lib/soundfontEngine.ts`: owns a shared live `WorkletSynthesizer`
  for preview, a soundbank registry (default GM + user uploads), and an offline
  render path. `midiSynth.ts` keeps the built-in sawtooth as the "Basic" fallback
  instrument and delegates to the soundfont engine when an instrument is selected.
- Worklet processor (`spessasynth_processor.min.js`) served from `frontend/public`
  (copied from the package) and loaded via `audioWorklet.addModule`.
- Instrument model (layered):
  - `Instrument = { id, name, layers: Layer[], fx: FxChainConfig }`
  - `Layer` = soundfont (soundBankId, bank, program, transpose, gain, pan) |
    osc (waveform, transpose, gain, ADSR, filter) | sample (sampleRef, baseMidi,
    transpose, gain, ADSR, filter, loop). Sample refs can come from the existing
    `instrumentStore` (AI one-shots) or uploads.
  - Playing a note triggers every layer; soundfont layers go through SpessaSynth
    channels, osc/sample layers through our Web Audio voices, all summed into the
    per-instrument FX chain -> master.
- Store: `instrumentDefsStore` (zustand + localStorage) holds instrument
  definitions; audio buffers / soundbanks load on demand. Active instrument is a
  global default for v1, with per-track / per-MIDI assignment as a later step.

## Phases
- **I2.1 SpessaSynth engine + GM playback.** Add deps + worklet plumbing; load a
  default GM soundfont; route existing MIDI preview/render/bounce through a
  selected GM preset; keep sawtooth as "Basic". Delivers real GM instrument
  playback everywhere MIDI plays today.
- **I2.2 Instrument model + store + active-instrument selection.** Layered model,
  persisted defs store, a picker to choose the active instrument.
- **I2.3 Custom soundbank upload.** Upload SF2/SF3/DLS; persist (IndexedDB or
  backend); register with SpessaSynth.
- **I2.4 Full layered builder UI.** Add/remove layers, per-layer ADSR/filter/
  transpose/gain/pan, per-instrument FX chain, live preview, name + save.
- **I2.5 Routing/assignment.** Per-track / per-MIDI instrument assignment.

## Open asset decision
A default GM soundfont must ship for out-of-box playback. Options: bundle a small
FOSS GM SF3 in `frontend/public/soundfonts/` (offline-ready, adds a multi-MB
binary to the repo), fetch a known FOSS soundfont from a URL at runtime (no
binary committed, needs network on first use), or require the user to drop one
in. Recommendation: bundle a small FOSS GM SF3, since theDAW is local-first.

## Verification
Frontend audio: confirmed by the user's ears, never headless. Each phase ends
with a live listen (piano-roll preview + a MIDI bounce in the Library) plus a
typecheck/build. Update the RAG doc + DOC_PATHS when the feature is user-facing.
```

Approval-based per the repo rule: docs change only describes the plan.
