# UI Hover Text Guide — Stable Audio 3

Every tooltip, hover-over, and info blurb for the generation interface. Each entry is written to be instantly understandable by someone who has never used this tool before. Copy-paste ready for the React tooltip components in the generation UI.

---

## Writing Rules Used in This Document

1. **One breath** — Each tooltip should be readable in a single glance. Two sentences max for simple controls, three for complex ones.
2. **Lead with what it does** — Not what it is. "Controls how long..." not "This is a parameter that..."
3. **Include the default** — So users know what "normal" looks like.
4. **Include the range** — So users know what's possible.
5. **Suggest values** — Give starting points for common use cases.
6. **No jargon without translation** — If a technical term is unavoidable, define it inline.
7. **Use analogies** — Musical/audio production analogies when they help.

---

## Prompting

### Prompt (text box)

```
Describe the audio you want. Be specific: genre, instruments, tempo (BPM), mood, and texture.
Example: "120 BPM house loop, deep sub bass, crispy hi-hats, vinyl crackle"
```

### Negative Prompt (text box)

```
Describe what you DON'T want. The model will actively avoid these qualities.
Example: "poor quality, distortion, vocals, silence"
Only active when CFG scale is above 1.0.
```

### Prompt Tips Banner

```
Be specific — include genre, instruments, tempo (BPM), mood, and texture.
Example: "120 BPM house loop, deep sub bass, crispy hi-hats, vinyl crackle"
```

---

## Main Controls

### Seconds Total (slider)

```
How long the generated audio will be, in seconds. Default: 120.
Longer clips use more VRAM. The model handles any length natively — no wasted compute.
Small model max: ~2 min. Medium model max: ~4.75 min.
```

### Steps (slider)

```
How many refinement passes the model makes. More steps = more detail, but diminishing returns.
ARC models: Leave at 8. They're optimized for it — going higher barely helps.
RF models: Start at 50. Below 20 sounds noticeably worse.
```

### CFG Scale (slider)

```
How strictly the model follows your prompt vs. improvising on its own.
1.0 = Freestyle (ARC default — guidance isn't needed).
7.0 = Strong prompt adherence (RF default).
Above 15 = Risk of artifacts and over-saturation.
Lower = more creative freedom. Higher = tighter prompt matching.
```

---

## Sampler Params

### Seed (number box)

```
The random starting point for generation. Same seed + same settings = identical output every time.
-1 = Random (every generation is unique).
Found something you love? Save the seed to recreate or tweak it later.
```

### Sampler Type (dropdown)

The dropdown itself gets this tooltip:

```
The algorithm that progressively builds audio from noise. Each has different speed/quality tradeoffs.
• Pingpong — Fast, excellent at 8 steps. Default for ARC models.
• Euler — Fastest option. Good for quick drafts and RF models.
• DPM++ — Medium speed, better quality per step. Best for RF models when quality matters.
• RK4 — Slowest (4x Euler), most mathematically precise. Use when you want maximum accuracy.
```

If individual dropdown options can have tooltips:

**Pingpong:**
```
Fast sampler optimized for low step counts. Best choice for ARC models at 8 steps.
```

**Euler:**
```
Simplest and fastest sampler. Great for quick drafts. The go-to for RF models with higher step counts.
```

**DPM++:**
```
Balanced sampler — better quality per step than Euler, slightly slower. Ideal for RF models when quality matters more than speed.
```

**RK4:**
```
Most precise sampler — uses 4 function evaluations per step (4x slower than Euler). Use when you want maximum mathematical accuracy and don't mind waiting.
```

### Sigma Max (slider)

```
Starting noise level. Default: 1.0.
At 1.0 = Generates from pure noise (normal generation).
Below 1.0 (with init audio) = More of the original audio survives.
Only matters when using init audio — leave at 1.0 for normal generation.
```

### Duration Padding (slider)

```
Extra seconds added internally so reverb tails and decays don't get cut off abruptly. Default: 6 sec.
This padding is trimmed from your output — it just gives the model room to let sounds decay naturally.
Increase for ambient/reverb-heavy content. Decrease for tight loops.
```

---

## Guidance Fine-Tuning

### APG Scale (slider)

```
Anti-saturation filter for guidance. Think of it as a "tasteful guidance" knob. Default: 1.0.
1.0 = Full protection — removes harsh/overblown artifacts from guidance, keeps the detail.
0.0 = Raw guidance with no protection — may oversaturate at high CFG.
Only matters when CFG > 1. At CFG 1.0 (ARC default), this has no effect.
```

### CFG Interval Min (slider)

```
Skip guidance during the noisiest stages of generation. Default: 0.0.
Raising this (try 0.2) can reduce artifacts while keeping prompt adherence.
Only matters when CFG > 1.
```

### CFG Interval Max (slider)

```
Skip guidance during the cleanest/final stages of generation. Default: 1.0.
Lowering this (try 0.8) can reduce over-processing in the final details.
Only matters when CFG > 1.
```

### CFG Rescale (slider)

```
Tames the volume and saturation boost that high CFG causes. Default: 0.0 (off).
Turn up (0.3–0.7) if your output sounds overblown, clipping, or too loud with high CFG.
1.0 = Full correction. Only matters when CFG > 1.
```

### CFG Norm Threshold (slider)

```
Safety valve that caps how large the guidance correction can get. Default: 0.0 (disabled).
Raise this if you hear random pops, clicks, or distortion with high CFG values.
Higher values = stricter cap on guidance spikes. Only matters when CFG > 1.
```

---

## Sampling Schedule Shift

### Schedule Shift Type (dropdown)

The dropdown itself:

```
Controls where the model focuses its denoising effort across the generation process.
• None — Equal effort at all stages. No adjustment.
• LogSNR — Rebalances effort using a log curve. More focus on structure-forming stages. (Default)
• Flux — Extra effort at high-noise stages where musical structure forms. Good for longer audio.
• Full — Combines both training and sampling shifts together.
Leave at default unless output sounds mushy (try more shift) or over-processed (try less).
```

If individual options can have tooltips:

**None:**
```
No schedule adjustment. The model spreads effort equally across all denoising stages.
```

**LogSNR:**
```
Rebalances effort using a logarithmic curve — more focus on the stages where musical structure forms. Default and recommended for most use cases.
```

**Flux:**
```
Spends extra effort at high-noise stages where broad musical structure is decided. Especially useful for longer audio (2+ minutes).
```

**Full:**
```
Applies both training-time and sampling-time shifts together. Most aggressive schedule adjustment. Use if LogSNR alone isn't enough.
```

### LogSNR Sub-Parameters

**Anchor Length:**
```
Reference sequence length the shift curve is calibrated around. Default: 2000.
Advanced — leave at default unless tuning for very short or very long sequences.
```

**Anchor log-SNR:**
```
How much effort goes to structure-forming stages. Default: -6.2.
More negative = more effort on structure. Less negative = more balanced.
Advanced — the default is tuned for the model.
```

**Rate:**
```
How quickly the shift scales with audio duration. Default: 0.0.
Positive = more shift for longer audio. Negative = less shift for longer audio.
Advanced — leave at default.
```

**log-SNR End:**
```
Where the shift tapers off at the end of generation. Default: 2.0.
Advanced — leave at default unless experimenting with final detail quality.
```

### Flux Sub-Parameters

**Min Seq Len:**
```
Shortest sequence length the shift is calibrated for. Default: 256.
Advanced — only change if generating very short clips.
```

**Max Seq Len:**
```
Longest sequence length the shift is calibrated for. Default: 4096.
Advanced — only change if generating very long clips.
```

**Alpha Min:**
```
Shift strength at short durations. Default: 6.93.
Higher = stronger shift for short audio. Advanced — leave at default.
```

**Alpha Max:**
```
Shift strength at long durations. Default: 6.93.
Higher = stronger shift for long audio. Advanced — leave at default.
```

### Full Sub-Parameters

**Base Shift:**
```
Minimum schedule shift applied at short sequence lengths. Default: 0.5.
Advanced — leave at default.
```

**Max Shift:**
```
Maximum schedule shift applied at long sequence lengths. Default: 1.15.
Higher = more aggressive shift for long audio. Advanced — leave at default.
```

**Min Length:**
```
Sequence length where the base (minimum) shift applies. Default: 256.
Advanced — leave at default.
```

**Max Length:**
```
Sequence length where the max shift applies. Default: 4096.
Advanced — leave at default.
```

---

## Init Audio (Audio-to-Audio)

### Init Audio Accordion Description

```
Upload a recording as a starting point. The model transforms it based on your prompt.
Lower noise level = more of the original preserved.
```

### Init Audio (upload)

```
Upload the audio file you want to use as a starting point. The model will transform it guided by your prompt.
Supports WAV, MP3, FLAC, and other common formats.
```

### Init Audio Type (radio: Init Audio / RF-Inversion)

```
Choose the audio-to-audio technique.
• Init Audio — Adds noise to your audio, then regenerates. Simple and effective.
• RF-Inversion — Reverse-engineers your audio back into noise space more carefully, then regenerates. Better preserves timing and transients. RF models only.
```

### Init Noise Level (slider)

```
How much of the original audio survives the transformation. Default: 0.9.
0.1 = Subtle remix — like adding effects to a finished track.
0.3 = Loose cover — same structure, different performance.
0.5 = Inspired by — recognizable DNA but a new piece.
0.7 = Heavy remix — broad strokes remain.
0.9 = Almost from scratch — just a hint of the original.
1.0 = Original ignored entirely (same as not using init audio).
Start at 0.7–0.9 for creative variations. Use 0.1–0.3 to keep rhythm and structure.
```

### RF-Inversion: Inversion Steps (slider)

```
How carefully the model analyzes your input audio before regenerating. Default: 100.
More steps = more faithful to the original's structure and timing.
Fewer steps = faster but less precise reconstruction.
```

### RF-Inversion: Gamma (slider)

```
Creative freedom during the analysis phase. Default: 0.0.
0.0 = Maximum faithfulness to the source.
0.3 = Slight creative liberty.
1.0 = Maximum reinterpretation — the model takes big liberties.
For reproduction: use 0.3. For creative restyling: use 0.0–0.15.
```

### RF-Inversion: Unconditional (checkbox)

```
When ON: The model ignores your text prompt during analysis, reconstructing purely from the audio's structure.
Your prompt only affects the regeneration step. Default: OFF.
Gives cleaner separation between "what to keep from the original" and "what to change with the prompt."
Best for prompt-based restyling — check this ON, then write a prompt describing the new style.
```

---

## Inpainting

### Inpainting Accordion Description

```
Regenerate a specific time region while keeping everything else untouched.
For continuation: set Mask Start to end of your audio and increase Seconds Total.
```

### Inpaint Audio (upload)

```
Upload the audio file you want to partially regenerate.
Everything outside the mask region stays exactly as-is.
```

### Mask Start (slider)

```
Where the region to regenerate begins, in seconds. Default: 0.
Everything before this point is preserved untouched.
For continuation (extending audio): set this to the end of your existing audio.
```

### Mask End (slider)

```
Where the region to regenerate ends, in seconds. Default: end of audio.
Everything after this point is preserved untouched.
For continuation: set this beyond the end of your audio (and increase Seconds Total to match).
```

---

## LoRA (Style Patches)

### LoRA Accordion Title

```
LoRA [Name]: Style patch trained on specific audio. Steers the model toward a particular sound without retraining.
```

### Strength (slider)

```
How much this style patch influences the output. Default: 1.0.
0.0 = Completely off — no effect.
1.0 = Full effect — style applied as trained.
Above 1.0 = Amplified/exaggerated effect (can get weird above 2.0).
Start at 1.0. If it's too dominant, try 0.3–0.7.
```

### Interval Min (slider)

```
Start applying this LoRA at this generation stage. Default: 0.0 (from the very beginning).
The generation process goes from noisy (1.0) to clean (0.0).
Early stages (near 1.0) = LoRA affects broad style and structure.
Late stages (near 0.0) = LoRA affects fine texture and detail.
```

### Interval Max (slider)

```
Stop applying this LoRA at this generation stage. Default: 1.0 (all the way through).
Set to 0.5 to only affect early structural stages. Set to 0.3 for texture-only influence.
Use with Interval Min to target specific parts of the generation process.
```

### Layer Filter (text box)

```
Target specific model layers. Leave empty to affect all layers (default). Advanced.
Enter comma-separated layer name patterns.
Example: ".transformer.layers[0-11]" affects only the first 12 transformer layers.
Layers matching any pattern are DISABLED — all others remain active.
```

### Multi-LoRA General Note

```
Multiple LoRAs are applied simultaneously. Each has independent strength, interval, and layer controls.
Stack a style LoRA (full interval) with a detail LoRA (interval 0.0–0.5) for layered control.
```

---

## Output Params

### Output Params Accordion Description

```
Control file format, naming, and playback behavior.
```

### File Format (dropdown)

The dropdown itself:

```
Output audio format. Default: WAV.
• WAV — Lossless, perfect quality. Large files. Best for final masters and further editing.
• FLAC — Lossless, ~50% smaller than WAV. Best for archiving and sharing without quality loss.
• MP3 320k — Near-perfect lossy. Small files. Nearly indistinguishable from WAV.
• MP3 V0 — Near-perfect variable bitrate. Slightly smaller than 320k, same perceived quality.
• MP3 128k — Noticeable quality loss. Only for rough demos and previews.
• M4A 64k — Acceptable for speech/podcasts. Not suitable for music.
• M4A 32k — Minimum viable quality. Only for extreme bandwidth saving.
```

If individual options can have tooltips:

**WAV:**
```
Lossless, perfect quality. Largest file size. Use for final masters or when you'll edit the audio further.
```

**FLAC:**
```
Lossless like WAV but ~50% smaller. Perfect quality with better file sizes. Great for archiving.
```

**MP3 320k:**
```
Near-perfect lossy compression. Very small files. Nearly indistinguishable from WAV for most listeners.
```

**MP3 V0:**
```
Variable bitrate MP3 — same perceived quality as 320k, slightly smaller file size. Uses more bits where the audio is complex, fewer where it's simple.
```

**MP3 128k:**
```
Noticeable quality loss, especially on high frequencies and transients. Only use for rough demos or previews, not final output.
```

**M4A AAC-HE v2 64k:**
```
Efficient codec designed for speech and streaming. Acceptable for podcasts and voice. Not recommended for music — too much detail lost.
```

**M4A AAC-HE v2 32k:**
```
Minimum viable audio quality. Extremely small files. Only use when bandwidth is severely constrained. Significant quality loss.
```

### File Naming (dropdown)

The dropdown itself:

```
How the output file is named. Default: Verbose.
• Verbose — Includes prompt, CFG value, and seed in the filename. Best for tracking experiments.
• Prompt — Just the prompt text. Cleaner but less info for reproduction.
• output.wav — Generic name. For quick single generations when you don't need to track settings.
```

If individual options can have tooltips:

**Verbose:**
```
Includes prompt text, negative prompt, CFG value, and seed in the filename. Makes it easy to reproduce or tweak any generation later.
```

**Prompt:**
```
Just the prompt text in the filename. Cleaner names, but you lose the settings info needed to exactly reproduce the result.
```

**output.wav:**
```
Simple generic filename. Each new generation overwrites the previous one. Use for quick one-off generations.
```

### Spec Preview Every (slider)

```
Show a visual spectrogram snapshot every N steps during generation. Default: 0 (disabled).
Set to 1 to see every step. Set to 2–4 for occasional snapshots without slowing things down.
Lets you watch the audio take shape in real time — frequencies displayed over time.
```

### Cut to Seconds Total (checkbox)

```
Trim the output to exactly your requested duration, removing any silent padding at the end. Default: ON.
Turn OFF if you want to hear the natural decay/reverb tail that extends beyond your requested length.
```

### Autoplay (checkbox)

```
Automatically play the audio as soon as generation finishes. Default: OFF.
Turn ON for a hands-free workflow — hear results immediately without clicking play.
```

### Infinite Radio (checkbox)

```
Continuously generate new tracks back-to-back — an endless AI music stream. Default: OFF.
When the current track nears its end, a new generation auto-starts and plays seamlessly.
Great for background listening, inspiration sessions, or finding unexpected ideas.
```

### Auto Download (checkbox)

```
Automatically save each generated file to your downloads folder. Default: OFF.
Turn ON to capture every generation without manually downloading. Useful during long exploration sessions.
```

---

## Output Section

### Output Audio (player)

```
Your generated audio. Click play to listen, or use the download button to save.
```

### Output Spectrogram (gallery)

```
Visual representation of your audio — frequencies shown over time.
Bright areas = loud frequencies. Dark areas = quiet or absent.
Useful for spotting issues like clipping, missing frequency ranges, or unwanted silence.
If Spec Preview was enabled, earlier steps are shown too so you can see how the audio evolved.
```

### Send to Init Audio (button)

```
Load this output as the starting point for audio-to-audio generation.
Opens the Init Audio section with this audio pre-loaded. Adjust noise level and prompt, then generate a variation.
Great for iterative refinement: generate → send to init → tweak → generate again.
```

### Send to Inpaint Audio (button)

```
Load this output into the Inpainting section for partial regeneration or continuation.
Set a mask region to regenerate just one section while keeping the rest.
Or set Mask Start to the end for continuation — the model will extend your audio naturally.
```

---

## Model-Specific Behavior Quick Reference

These tooltips can be placed on a model indicator or info badge in the UI:

### ARC Model Active

```
ARC model loaded. Optimized for fast, high-quality generation.
Recommended settings: 8 steps, CFG 1.0, Pingpong sampler.
Guidance controls (CFG, APG, etc.) have no effect at CFG 1.0.
```

### RF Model Active

```
RF (Rectified Flow) model loaded. More configurable, requires more steps.
Recommended settings: 50 steps, CFG 7.0, DPM++ or Euler sampler.
Supports RF-Inversion for precise audio-to-audio transformations.
```

---

## Contextual Tips (Optional Placement)

These are longer tips that could appear as info banners, accordion descriptions, or help sections rather than individual control tooltips.

### First-Time Prompting

```
New to prompting? Start simple: describe the genre and mood.
"Chill lo-fi beat with soft piano and rain sounds"
Then get more specific: add tempo, instruments, texture, structure.
"85 BPM lo-fi hip hop, dusty vinyl piano chords, tape hiss, side-chain pumping kick, mellow Rhodes bass"
```

### When CFG Controls Don't Seem to Work

```
Using an ARC model? CFG defaults to 1.0, which means guidance is off.
All guidance controls (CFG interval, APG, rescale, norm threshold) only activate when CFG > 1.
ARC models are designed to work great without guidance — these controls are mainly for RF models.
```

### Init Audio Workflow

```
Audio-to-Audio workflow:
1. Upload a recording in the Init Audio section
2. Set noise level (lower = more original preserved)
3. Write a prompt describing what you want it to become
4. Generate — the model transforms your audio guided by the prompt
5. Love it? Save it. Almost there? Send to Init Audio and iterate.
```

### Inpainting Workflow

```
Fix or replace a section:
1. Upload your audio in the Inpainting section
2. Set Mask Start and Mask End to define the region to regenerate
3. Write a prompt describing what should replace that section
4. Generate — everything outside the mask stays untouched

For continuation (extending audio):
1. Upload your audio
2. Set Mask Start to the end of your audio
3. Set Mask End and Seconds Total beyond it
4. Prompt what should come next — the model continues naturally
```

### LoRA Stacking Strategy

```
Stacking multiple LoRAs:
• Use one LoRA for overall style (full interval 0.0–1.0, strength 1.0)
• Use another for fine detail/texture (interval 0.0–0.5, strength 0.5)
• Reduce strength if combined LoRAs are too dominant
• Each LoRA is controlled independently — experiment with different combinations
```
