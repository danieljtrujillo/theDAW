## Draw, Vocal-to-MIDI, Notation & Arpeggiator

This area covers everything that turns a gesture, a voice, or a MIDI file into playable music and readable scores. It spans a frontend draw-to-music instrument and arpeggiator plus four backend modules (`vocal`, `midi`, `notation`, `sheetimport`), and it runs almost entirely on your own machine.

### DRAW — sketch to music
The **DRAW** tab is a generative instrument: draw on the canvas and it plays. Two controls shape the sound:
- **Brush** (Organic L-system, Fibonacci phyllotaxis, Neural graph, Nebulous cloud) sets both the visual growth and the sonic articulation of each stroke.
- **Mode** routes every voice through one of 12 built-in effects (compressor, tremolo, distortion, echo, reverb, bitcrush, ring-mod, stereo widen, exciter, HRTF orbit, formant, lowpass) or a live psychoacoustic rack insert.

Strokes make sound three ways: a filtered-noise **Drone**, held notes on the **Soundfont** GM engine (`spessasynth_core`/`spessasynth_lib`), or **Granular** grains sampled from a library song — or from a live **Magenta** stream (local Magenta RT2 sidecar). Record a session to save it to the library or drop it on an EDIT track, and hand your drawn melody to Magenta to jam a full arrangement. Built on the shared Web Audio graph (`frontend/src/lib/drawEngine.ts`).

### Vocal-to-MIDI
Two complementary paths:
- **Vocal Engine (backend `/api/vocal`)** prepares a canonical vocal artifact: isolation + cleanup, a dense F0 curve (`librosa.pyin`), notes via **basic-pitch** (Spotify `ICASSP_2022_MODEL_PATH`), RMS voice-activity segmentation, tempo (`librosa.beat.beat_track`), and optional word-timed lyrics via **faster-whisper** (model `small`, CPU `int8`, isolated venv). Includes a notes->MIDI->notes round-trip drift validator.
- **Vocal2Midi panel (frontend)** does live in-browser YIN pitch tracking, routes mic recordings through the backend basic-pitch path for quality, shapes notes with genre sound-profiles, and writes Standard MIDI directly. Optional AI cleanup/analysis uses **`gemini-3.5-flash`** through theDAW's server-side proxy (`@google/genai`); it is optional — MIDI works with no API key.

### Audio-to-MIDI engine (`/api/midi`)
Full tracks and stems convert to MIDI via **basic-pitch** (multi-instrument, default) or, for piano stems, Bytedance's **piano-transcription-inference** (`CRNN_note_F1=0.9677_pedal_F1=0.9186.pth`, CPU). Both lazy-load, degrade gracefully if missing, and auto-provision on demand.

### Notation / SCORE
The **SCORE** tab makes MIDI a first-class notation artifact. **music21** writes MusicXML and ABC directly (titled and artist-credited); the **MuseScore 4 CLI** engraves PDF/SVG when installed. A dynamic-programming arranger produces playable guitar/bass **tablature** (alphaTex), and rule-based arrangers produce **lead-sheet, piano-reduction, simplified, and band-score** MusicXML. Previews render as book-style A4 pages with **OpenSheetMusicDisplay** and tabs with **alphaTab**, both lazily code-split.

### Arpeggiator
A pure-data chord-progression arpeggiator (a TypeScript port of Jake Albaugh's MusicalScale + ArpeggioPatterns) rehosted on the app's Web Audio synth via a lookahead scheduler. Supports swing/quantize feel and a bass voice, and can render a whole progression straight into the piano roll. No Tone.js, no CDN, no model.

### Sheet import
Drop a **MusicXML, ABC, Humdrum kern, or MIDI** score and it parses (via **music21**) into a piano-roll note batch on the 16th-note grid, expanding repeats and stripping ties, with a bpm/time-signature/key hint.

### Runs offline?
Yes, effectively all of it. DRAW, arpeggiator, sheet import, the Vocal Engine, and audio-to-MIDI run locally (model checkpoints for basic-pitch/piano-transcription/whisper download once, then cache and run CPU-only). PDF/SVG needs a local MuseScore install but degrades to MusicXML/ABC. The only true cloud call is the optional Gemini vocal-cleanup, which needs `GEMINI_API_KEY` on the server.
