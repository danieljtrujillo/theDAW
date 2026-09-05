## Chimera — Splice & Braid Multiple Sounds (CRISPR/DNA Mashup)

Chimera stacks two or more audio clips and fuses them into a single seed clip that feeds Stable Audio 3's diffusion generator as init audio. Since September 2026 it ships two engines: the **v2 phrase engine** (default) builds a tempo-, key- and structure-aware arrangement with a song arc, loudness-matched lanes and a mastered output sized to the generation Length; the **v1 chunk engine** (the "v1" pill) is kept for A/B listening. The DNA-helix visualiser shows each clip as a strand, twists them into a double helix on CREATE, and braids the chosen phrases into one master strand.

Backend module: `backend/modules/chimera/` (mounted at `/api/chimera`).
Frontend: `frontend/src/components/chimera/` and `frontend/src/lib/chimeraClient.ts`; CREATE wiring in `frontend/src/state/generateStore.ts`.

### What it does

- **Stack clips** by drag-and-drop from the library or the desktop, from the media bucket, or from the editor. Each clip is analyzed the moment it lands and shows its detected **BPM**, **key** with Camelot code, and stretch ratio. After a render the row also shows the tempo octave used (½x / 2x), the pitch shift in semitones, an **off-key** flag for harmonic outliers, a **stems** badge when cached Demucs stems were used, and the lane placements ("lead x3 · sup x2").
- **Target BPM**: a fixed value, a chosen **Base** clip whose tempo everyone matches, or **Auto** (weighted median of the detected BPMs after folding each into 80–160).
- **Align**: **Start** (all clips begin together), **Downbeat** (each clip trimmed to its first downbeat) or **CRISPR** (the weave). Start and Downbeat always use the v1 path.
- **CRISPR controls**: **Phrase** (4, 8 or 16 bars per phrase), **Total** (bars; 0 = size the mashup to the generation Length), **Poly** (how many clips may overlap, 1–8, default 3), **Key** (Auto = Camelot key matching, Off = every clip stays in its own key), **Arc** (Song = intro/build/peak/release/outro, Rise = continuous build, Flat = DJ blend), **Heal** (Off, Preserve, Polish) and the **v1** pill.
- On **CREATE** the mashup is set as the generation's init audio. With an empty prompt box a prompt is derived from the clips and the mashup's tempo and key and written back into the box. The **use hint** pill appends the mashup's "124 BPM, key of A minor" hint to whatever prompt is sent.
- The mashup is **pre-rendered in the background** whenever the stack or the Length settles, so CREATE usually finds a warm result; the "Last mashup" line under the stack reports length, tempo, engine, key, arc and seam count.

### How a v2 mashup is built

1. **Normalize** every upload to 44.1 kHz stereo WAV via ffmpeg.
2. **Analyze** each clip (`analysis.py`, cached by sha256 under `data/cache/chimera/`): tempo and beats with aubio, cross-checked against librosa and replaced when aubio's list is sparse or irregular; the BPM is refined from the fitted beat grid; key via Krumhansl-Schmuckler profiles with a strength score; a material profile (percussive ratio, low-band fraction, integrated LUFS); and a bar table with downbeat and phrase phase (`structure.py`). A clip is **tonal** only when it has a key with enough strength and confidence and is not mostly percussive. Results the client already holds are echoed back as `known_analysis`, so the mashup skips detectors it does not need.
3. **Tempo** (`tempo.py`): the target comes from the Base clip, the user, or the folded weighted median. Each clip picks the octave multiplier (½, 1, 2) that brings it closest to the target, so a 70 BPM clip plays at double time next to 140 rather than being stretched 2x. When the length comes from the generation Length and the tempo from the median, the BPM is nudged by at most 3 % so whole bars fit exactly.
4. **Harmony** (`harmony.py`): with Key = Auto the solver picks the one target key that minimises the weighted pitch-shift cost across the tonal clips, allowing at most 2 semitones per clip (down preferred on ties), with a bonus for the Base clip's key and the strongest key. Clips that cannot reach a Camelot-compatible key within the cap are **harmonic outliers**: left unshifted, never used as supports, and reported.
5. **Arrangement** (`arrange.py`, pure and seeded): the timeline is split into phrase-sized slots with an energy contour from the chosen Arc. A greedy pass chooses the **lead** clip and phrase per slot (intro phrases at the start, outro at the end, minimum run lengths, switch costs); a second pass adds **supports** up to the wanted density, checking polyphony on both sides of every line so crossfade tails never exceed the cap; a coverage pass gives every unplaced clip one slot. Consecutive phrases merge into runs; seams are emitted at every slot line (lead switch = blend over 1–2 bars, drop = hard cut, support in/out = 1-bar fade) with a **heal window** each, budgeted to at most 35 % of the timeline.
6. **Conform** (`conform.py`): every run is rendered from its source span with a margin, time-stretched and pitch-shifted with ffmpeg's librubberband (percussive / tonal / default presets chosen from the material profile; atempo fallback without pitch shift), and **grid-locked** when the clip's beat grid is confident and steady: a smoothed warp of at most 1.5 % rate deviation puts its beats on the target lattice. The lock is skipped when the beats and the lattice disagree by more than 60 ms median, which happens on tracks with irregular timing.
7. **Stems** (`stems.py`): for library clips whose Demucs stems are already cached, the lead plays drums + bass (the "found" role) plus vocals/other/guitar/piano (the "layer" role), and supports play only the layer; nothing is ever separated on the fly.
8. **Render** (`render.py`): runs are placed on lead and support buses, each loudness-normalised to its lane target (lead −16 LUFS, support −22 LUFS) with the clip weight folded in. Lead switches at a blend seam split at 120 Hz: the highs crossfade, the lows do a one-beat **bass swap** with a polarity check. Supports are high-passed at 150 Hz and ducked by the lead's low-band envelope.
9. **Master** (`master.py`): mono below 120 Hz, normalise to −16 LUFS, a look-ahead peak limiter at −1 dBFS, a one-beat fade-in and one-bar fade-out, 16-bit PCM WAV.

The response keeps every v1 field and adds the v2 ones: engine, harmony mode and arc used, bars and tempo fit, target key and Camelot code, prompt hint, sections, seams with heal windows, lane and master loudness, true peak, limiter gain reduction, and per clip the octave multiplier, pitch shift, key data, downbeat and phrase confidence, grid-lock status, conformed beat times, sources used and phrase table.

### Seam healing at CREATE

- **Off**: the mashup is plain init audio.
- **Preserve**: one generation pass; the mashup is also sent as inpaint audio with the seam heal windows as `inpaint_regions`, so the phrase bodies are kept and only the joins are recomposed.
- **Polish**: a second generation job runs on the first result with the same windows and a low init noise, recomposing the seams in the generated texture. This roughly doubles model time.

### The DNA visualiser

`ChimeraDnaScene.tsx` draws one three.js WebGL scene. Each clip is a flat waveform lane shaped by its decoded peaks, with beat rungs placed from the conformed, grid-locked beat times after a render, support placements drawn as smaller beads, and the real phrase placements flying into a shared output strand coloured by the gradient of contributing voices. Layout is measured live from the DOM (`data-crispr-lane` / `data-crispr-output` anchors).

### The v1 engine

The v1 chunk engine (Start, Downbeat, and CRISPR with the v1 pill) is unchanged: bar-aligned chunks of the default 8 bars are scattered across a 90-bar timeline (or the Base clip's length) with intro/outro priority and a polyphony cap, stretched with librubberband or atempo, and mixed with RMS normalisation. It does no key matching, no octave choice, no loudness matching and no mastering.

### Models & libraries

- **aubio** and **librosa** — beat tracking (cross-checked), key detection, onset and spectral features
- **ffmpeg** with **librubberband** — decode, time-stretch and pitch shift (atempo fallback)
- **numpy**, **scipy**, **pyloudnorm**, **soundfile** — arrangement DSP, LUFS metering, limiter, WAV I/O
- **three** + Web Audio API — DNA visualiser

No neural or LLM models are used in the mashup itself; all analysis is classical DSP. Cached Demucs stems are consumed when present but never produced here.

### Runs on modest hardware, fully offline

Everything runs locally with no network or API keys. Analysis is cached per clip, decode/conform run concurrently under a 3-way semaphore in worker threads, and a three-clip 110 s mashup renders in roughly 15 s on a desktop CPU. If ffmpeg or aubio is missing the mashup returns a 503 with an install hint while single-clip analysis still works through the librosa fallback. The `data/cache/chimera/` folder is git-ignored and safe to delete.
