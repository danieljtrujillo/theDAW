## Draw, Vocal-to-MIDI, Notation & Arpeggiator

This area covers everything that turns a gesture, a voice, or a MIDI file into playable music and readable scores. It spans a frontend draw-to-music instrument and arpeggiator plus four backend modules (`vocal`, `midi`, `notation`, `sheetimport`), and it runs almost entirely on your own machine.

### DRAW — sketch to music
The **DRAW** tab is a generative instrument: draw on the canvas and it plays. Two controls shape the sound:
- **Brush** (Organic L-system, Fibonacci phyllotaxis, Neural graph, Nebulous cloud) sets both the visual growth and the sonic articulation of each stroke.
- **Mode** routes every voice through one of 12 built-in effects (compressor, tremolo, distortion, echo, reverb, bitcrush, ring-mod, stereo widen, exciter, HRTF orbit, formant, lowpass) or a live psychoacoustic rack insert.

Strokes make sound three ways: a filtered-noise **Drone**, held notes on the **Soundfont** GM engine (`spessasynth_core`/`spessasynth_lib`), or **Granular** grains sampled from a library song — or from a live **Magenta** stream (local Magenta RT2 sidecar). Record a session to save it to the library or drop it on an EDIT track, and hand your drawn melody to Magenta to jam a full arrangement. Built on the shared Web Audio graph (`frontend/src/lib/drawEngine.ts`).

### Vocal-to-MIDI
Two complementary paths:
- **Vocal Engine (backend `/api/vocal`)** prepares a canonical vocal artifact: isolation + cleanup, a dense F0 curve (`librosa.pyin`), notes via **basic-pitch** (Spotify `ICASSP_2022_MODEL_PATH`) read as a lead vocal (the voice's pitch range and thresholds, one note at a time), RMS voice-activity segmentation, tempo (`librosa.beat.beat_track`), and optional word-timed lyrics via **faster-whisper** (model `small`, CPU `int8`, isolated venv). Includes a notes->MIDI->notes round-trip drift validator.
- **Vocal2Midi panel (frontend)** does live in-browser YIN pitch tracking, routes mic recordings through the backend basic-pitch path for quality, shapes notes with genre sound-profiles, and writes Standard MIDI directly. Optional AI cleanup/analysis uses **`gemini-3.5-flash`** through theDAW's server-side proxy (`@google/genai`); it is optional — MIDI works with no API key.

### Audio-to-MIDI engine (`/api/midi`)
Full tracks and stems convert to MIDI through three engines. **basic-pitch** (multi-instrument) takes the full track and every pitched stem. A piano stem goes to Bytedance's **piano-transcription-inference** (`CRNN_note_F1=0.9677_pedal_F1=0.9186.pth`, on CUDA when there is a GPU, else the CPU) when that package imports, and to basic-pitch otherwise. A drum stem, and each LARSNET kit part of a 12-stem split (kick, snare, toms, hi-hat, cymbals), goes to the model-free drum engine (`drum-onsets`). basic-pitch and the piano engine lazy-load, degrade gracefully if missing, and auto-provision on demand. The drum engine needs no install.

Each stem converts as its instrument, which the runner reads from the stem's name (`role_for_stem`: the Demucs and LARSNET stem names, the lead/backing vocal split and the usual hand-named variants). basic-pitch runs with that role's pitch range, onset and frame thresholds and shortest note, and writes the file on the role's General MIDI program:

| Role | Program |
|---|---|
| Bass | 33, Electric Bass (finger) |
| Lead vocal | 53, Voice Oohs |
| Backing vocals | 52, Choir Aahs |
| Guitar | 25, Acoustic Guitar (steel) |
| Piano | 0, Acoustic Grand Piano |
| Other | 48, String Ensemble 1 |

The full track, a `no_vocals` stem and a stem whose name gives no instrument keep basic-pitch's default settings and program 4 (Electric Piano 1). A bass stem and a lead vocal stem come out one note at a time. Of notes struck together, a bass line keeps the lower note unless it is much quieter or is the tail of the note before, and a vocal line keeps the louder note. A quieter note that starts under a sounding note, and on a bass line sits above it, is dropped when it ends inside that note or sits at one of its overtones. Any other note is the next note of the line. These two files keep each note's own pitch bend, centred on the note, and the wheel returns to centre when a bent note ends. Every other basic-pitch file carries no pitch wheel.

The drum engine writes General MIDI drum notes on channel 10. On a kit part it writes each hit once, on that part's voice: a tom by its pitch, a hi-hat open or closed by how long it rings, a cymbal as a crash or a ride. Hits that do not rise in the part's own bands, and the faint bleed of the rest of the kit, are dropped.

Every file carries the entry's tempo, checked first (`backend/modules/analysis/tempo.py`). A missing analysis BPM, or one outside 50-220 BPM, is replaced by the beat list's own tempo (60 over the median gap between beats) when that lies inside the range. When neither is usable, the pitched files keep their engine's stock 120 BPM, and the drum engine estimates its own tempo and snaps no hit to the beat grid. The LOG names an analysis BPM it rejected.

The piano engine's package imports `audioread` without declaring it, so theDAW declares it. When basic-pitch or the piano engine does not import, the LOG says once which module is missing, and Settings' **MIDI Engines** card shows the reason in that engine's chip hover text. The card reads Ready only when basic-pitch or the piano engine imports, and shows **Install Basic Pitch** otherwise.

### Notation / SCORE
The **SCORE** tab makes MIDI a first-class notation artifact. **music21** writes MusicXML and ABC directly (titled and artist-credited); PDF and SVG are engraved headlessly by the same **OpenSheetMusicDisplay** build the tab draws with, and the **MuseScore 4 CLI** engraves them instead when that renderer is missing. Any format can be exported for one part of the sheet. A dynamic-programming arranger produces playable guitar/bass **tablature** (alphaTex), and rule-based arrangers produce **lead-sheet, piano-reduction, simplified, and band-score** MusicXML. Previews render as book-style A4 pages with **OpenSheetMusicDisplay** and tabs with **alphaTab**, both lazily code-split. A score, an arrangement, an export and the performed MIDI made from an entry's MIDI are laid out at the same checked tempo the MIDI runner stamps on that MIDI.

### Arpeggiator
A pure-data chord-progression arpeggiator (a TypeScript port of Jake Albaugh's MusicalScale + ArpeggioPatterns) rehosted on the app's Web Audio synth via a lookahead scheduler. Supports swing/quantize feel and a bass voice, and can render a whole progression straight into the piano roll. No Tone.js, no CDN, no model.

### Sheet import
Drop a **MusicXML, ABC, Humdrum kern, or MIDI** score and it parses (via **music21**) into a piano-roll note batch on the 16th-note grid, expanding repeats and stripping ties, with a bpm/time-signature/key hint.

### Runs offline?
Yes, effectively all of it. DRAW, arpeggiator, sheet import, the Vocal Engine, and audio-to-MIDI run locally (model checkpoints for basic-pitch, piano-transcription and whisper download once, then cache; basic-pitch and the piano engine run on the GPU when there is one, else the CPU). PDF/SVG need node and the frontend's dependencies (the headless OSMD renderer) or a local MuseScore install, and degrade to MusicXML/ABC when both are missing. The only true cloud call is the optional Gemini vocal-cleanup, which needs `GEMINI_API_KEY` on the server.
