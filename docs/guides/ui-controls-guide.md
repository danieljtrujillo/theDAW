# UI Controls Guide — Plain English Reference

A complete breakdown of every control in the generation interface. No jargon, no math — just what each knob does, what to try, and what to avoid.

---

## Driving a knob or a fader

Every continuous control in theDAW — the MIX knobs, the DJ FX sends, the track
faders, the SLIDE surface — answers to the same four gestures.

| Gesture | What it does |
|---|---|
| **Drag** up or down | Moves the value. Hold **Shift** for a quarter-speed fine drag. |
| **Double-click** | Resets to that control's default. A bipolar control goes back to centre. |
| **Arrow keys** | One step per press, or ten steps with **Shift**. **Home** and **End** jump to the top and the bottom. |
| **Wheel** | One step per notch, ten with **Shift** — **but only when the control has focus.** |

That last rule is deliberate and it is the one worth knowing. An unmodified
wheel over an *unfocused* knob does nothing to it: the page scrolls underneath
instead. These controls carry live level, so a knob you are merely scrolling
past must not move — it used to walk its value with no undo entry and no cue
that anything had happened.

Focus is cheap to get. Clicking a control focuses it (the click still starts a
drag as normal), and so does tabbing to it. Once it is focused, the wheel works
and the page no longer scrolls under the pointer.

---

## Prompting

| Control | What it does |
|---------|-------------|
| **Prompt** | Describe the audio you want. Be specific: genre, instruments, tempo, mood, structure. Example: `"120 BPM house loop, deep sub bass, crispy hi-hats, vinyl crackle"` |
| **Negative prompt** | Describe what you DON'T want. Steers the model away from unwanted qualities. Example: `"poor quality, distortion, vocals, silence"` |

**Tips:**
- Include tempo (BPM), instruments, genre, mood, and texture
- The more specific you are, the more the model follows your vision
- Negative prompt only matters when CFG scale > 1

---

## Main Controls

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **Seconds total** | 0–512 | 120 | How long the generated audio will be. Longer = more VRAM used during generation. The model handles variable lengths natively — it doesn't waste compute on unused silence. |
| **Steps** | 1–500 | 8 (ARC) | How many refinement passes the model makes. **ARC models are built for 8 steps** — going higher won't help much. RF models need ~50. Going below 4 on ARC or below 20 on RF sounds noticeably worse. |
| **CFG scale** | 0–25 | 1.0 (ARC) | How strictly the model follows your prompt vs. freestyling. **1.0** = model does its own thing (ARC default, guidance not needed). **7.0** = strong prompt adherence (RF default). **25.0** = over-saturated, likely artifacts. |

**Suggestions:**
- ARC models: leave Steps at 8, CFG at 1.0 — they're designed for this
- RF models: start with Steps 50, CFG 7.0 and adjust from there
- Want more creative freedom? Lower CFG. Want tighter prompt matching? Raise it.

---

## Sampler Params

### Core Sampler Settings

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **Seed** | -1 or any integer | -1 | The random starting point. Same seed + same settings = same result every time. **-1** means random — every generation is unique. Save a seed when you love a result and want to recreate or tweak it. |
| **Sampler type** | pingpong / euler / rk4 / dpmpp | pingpong (ARC) | The algorithm used to progressively build audio from noise. |
| **Sigma max** | 0–1 | 1.0 | Starting noise level. At 1.0 = generation from pure noise. Below 1.0 (with init audio) = controls how much original audio survives. |
| **Duration padding** | 0–30 sec | 6.0 | Extra seconds added internally so reverb tails and decays don't get cut off. The padding is silent in your output — it just gives the model room to breathe at the end. |

**Sampler types explained:**

| Sampler | Speed | Quality | Best for |
|---------|-------|---------|----------|
| **Pingpong** | Fast | Great at 8 steps | ARC models (default) |
| **Euler** | Fastest | Good | Quick drafts, RF models |
| **DPM++** | Medium | Better per-step | RF models, quality-focused |
| **RK4** | Slowest (4x Euler) | Most precise | When you want maximum accuracy |

### Guidance Fine-Tuning

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **APG scale** | 0–1 | 1.0 | Anti-saturation filter for CFG. At **1.0** (full APG): removes the harsh/overblown parts of guidance, keeping only the detail-enhancing component. At **0.0**: vanilla CFG with no protection. Think of it as a "tasteful guidance" knob. |
| **CFG interval min / max** | 0–1 each | 0.0 / 1.0 | Restricts guidance to only apply during certain stages of generation. Default (0–1) = guidance at all stages. Try **0.2–0.8** to skip guidance at the noisiest and cleanest stages — can reduce artifacts while keeping prompt adherence. |
| **CFG rescale** | 0–1 | 0.0 | Fixes the volume/saturation boost that high CFG causes. At **0.0**: no correction. At **1.0**: full correction. Turn this up if high CFG makes your outputs overblown or clipping. |
| **CFG norm threshold** | 0–100 | 0.0 | Safety valve that caps how large the guidance correction can get. At **0.0**: disabled. Higher values prevent sudden spikes that cause glitches. Use if you hear random pops or distortion with high CFG. |

**Suggestions:**
- For ARC at CFG 1.0: these don't matter — guidance isn't active
- For RF at CFG 7+: start with APG 1.0, if too aggressive try 0.5
- If you hear artifacts with high CFG: raise CFG rescale to 0.3–0.7

### Sampling Schedule Shift

Controls how the model distributes its effort across the generation process.

| Control | Options | Default | What it does |
|---------|---------|---------|-------------|
| **Schedule shift type** | LogSNR / Flux / Full / None | LogSNR | Changes where the model focuses its denoising work. |

| Type | Effect |
|------|--------|
| **None** | Equal effort at all stages |
| **LogSNR** | Rebalances effort using a log curve — more focus on structure-forming stages |
| **Flux** | Spends more effort at high-noise stages where musical structure forms — good for longer audio |
| **Full** | Applies both training and sampling shifts together |

**Sub-parameters** (only visible for the selected type):

**LogSNR:** Anchor length, Anchor log-SNR, Rate, log-SNR end
**Flux:** Min/Max seq length, Alpha min/max
**Full:** Base shift, Max shift, Min/Max length

**Suggestion:** Leave these at defaults unless your generations sound mushy (try more shift) or over-processed (try less). These are advanced — the defaults are tuned for the model.

---

## Init Audio (Audio-to-Audio)

Upload an existing audio file and use it as a starting point. The model will transform it guided by your prompt.

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **Init audio** | Audio upload | — | The source recording to transform |
| **Init noise level** | 0.01–1.0 | 0.9 | How much of the original survives |

**Noise level guide:**

| Value | Musical analogy | Use case |
|-------|----------------|----------|
| **0.1** | Subtle remix — like adding effects to a finished track | Small tweaks, texture changes |
| **0.3** | Loose cover — same structure, different performance | Genre transfer, rearrangement |
| **0.5** | Inspired by — recognizable DNA but a new piece | Creative variations |
| **0.9** | Sampled one note, built something new | Heavy transformation |
| **1.0** | Original ignored entirely | Same as not using init audio |

**Suggestions:**
- Start at 0.7–0.9 for creative variations
- Use 0.1–0.3 to preserve rhythm/structure while changing texture
- Your prompt steers WHAT the transformation becomes

### RF-Inversion (RF models only)

A more precise version of audio-to-audio. Instead of simply adding noise to your audio, the model first "reverse-engineers" it back into noise space more carefully, then re-generates. This preserves fine timing and transient details.

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **Inversion Steps** | 1–500 | 100 | How carefully the model "listens" to your input. More = more faithful to source structure. |
| **Gamma** | 0–1 | 0 | Creative freedom during inversion. 0 = maximum faithfulness. 0.3 = slight liberty. 1.0 = maximum reinterpretation. |
| **Unconditional** | On/Off | Off | When ON: inversion ignores text prompt, reconstructing purely from audio structure. The prompt only affects the re-generation step. Gives cleaner separation between "what to keep" and "what to change." |

**Suggestions:**
- For reproduction: empty prompt, CFG 1, gamma 0.3
- For prompt re-stylization: CFG 1–7, gamma 0–0.15, unconditional checked

---

## Inpainting

Regenerate only a specific section of an audio file while keeping everything else untouched. Like highlighting a section in your DAW and saying "redo just this part."

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **Inpaint audio** | Audio upload | — | The source audio to partially regenerate |
| **Mask Start (sec)** | 0–duration | 0 | Where the region to regenerate begins |
| **Mask End (sec)** | 0–duration | (duration) | Where the region to regenerate ends |

**Use cases:**
- Fix a flubbed section or awkward transition
- Replace a weak chorus while keeping verse and bridge
- Swap an instrument in a specific bar

### Continuation (extending audio)

Set Mask Start to the end of your existing audio and Mask End beyond it (with a longer Seconds Total). The model treats your audio as fixed context and generates new material that flows naturally from where yours left off — like asking a session musician to improvise an outro matching your intro.

---

## LoRA (Style Patches)

Small add-on "style patches" trained on specific audio (your own samples, a genre, a mood) that steer the model's output without retraining the whole thing. Only visible when LoRAs are loaded.

| Control | Range | Default | What it does |
|---------|-------|---------|-------------|
| **Strength** | 0–10 | 1.0 | How much the style patch influences output. 0 = off. 1.0 = full effect. Above 1.0 = amplified/exaggerated. |
| **Interval min / max** | 0–1 each | 0.0 / 1.0 | At which generation stages the LoRA is active. Early stages = broad style/structure. Late stages = fine texture/detail. |
| **Layer filter** | Text | (empty) | Which internal model layers the patch affects. Leave empty for all layers. Advanced use only. |

**Suggestions:**
- Start with strength 1.0, full interval (0–1)
- If the LoRA is too dominant, reduce strength to 0.3–0.7
- To apply LoRA only to early structural stages: set interval to 0.5–1.0
- Multiple LoRAs can be stacked and controlled independently

---

## Output Params

| Control | Options | Default | What it does |
|---------|---------|---------|-------------|
| **File format** | wav, flac, mp3 320k, mp3 v0, mp3 128k, m4a aac_he_v2 64k, m4a aac_he_v2 32k | wav | Output audio format |
| **File naming** | verbose, prompt, output.wav | verbose | How the output file is named |
| **Cut to seconds total** | On/Off | On | Trims output to exactly your requested duration |
| **Autoplay** | On/Off | Off | Plays audio automatically when generation finishes |
| **Infinite Radio** | On/Off | Off | Continuously generates new clips back-to-back — endless AI music stream |
| **Auto Download** | On/Off | Off | Saves generated file to your downloads folder automatically |
| **Spec Preview Every** | 0–100 | 0 (disabled) | Shows a visual spectrogram every N steps so you can watch the audio take shape during generation |

**File format guide:**

| Format | Quality | File size | Best for |
|--------|---------|-----------|----------|
| **WAV** | Perfect (lossless) | Large | Final masters, further editing |
| **FLAC** | Perfect (lossless) | ~50% smaller than WAV | Archiving, sharing without quality loss |
| **MP3 320k** | Near-perfect | Small | Sharing, listening, nearly indistinguishable from WAV |
| **MP3 V0** | Near-perfect (variable) | Slightly smaller than 320k | Same as 320k, marginally more efficient |
| **MP3 128k** | Noticeable loss | Very small | Rough demos, previews, not for final use |
| **M4A 64k** | Acceptable for speech | Tiny | Podcasts, voice, streaming |
| **M4A 32k** | Minimum viable | Smallest | Extreme bandwidth saving only |

**File naming:**
- **Verbose**: includes prompt text, CFG value, seed — best for tracking experiments
- **Prompt**: just the prompt text — cleaner but less info
- **output.wav**: generic name — for quick single generations

---

## Output Section

| Control | What it does |
|---------|-------------|
| **Output audio** | Plays back the generated audio |
| **Output spectrogram** | Visual representation of the audio — shows frequencies over time, useful for spotting issues |
| **Send to init audio** | Takes your generated output and loads it as init audio for audio-to-audio workflows |
| **Send to inpaint audio** | Takes your generated output and loads it for inpainting/continuation |

**Workflow tip:** Generate something you like → Send to init audio → adjust noise level and prompt → generate a variation. Iterate until perfect.
