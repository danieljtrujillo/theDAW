# Training a LoRA with Underfit

A start-to-finish walkthrough for training your first LoRA finetune of Stable
Audio 3 in theDAW's **Underfit** tab: prepare audio, pre-encode it, configure a
run, read the loss curve and demos, and pull out a `.safetensors` you can load
anywhere. For what each panel does, see the
[Underfit tab guide](underfit.md); for the adapter-type internals, see theDAW's
[LoRA guide](../workflows/lora.md).

## Before you start

One coherent style per dataset — one artist, one genre, or one SFX category.
Mixed bags train into mush. Quality matters more than quantity: ten minutes of
clean, consistent audio is the floor, thirty minutes or more is better. You do
not have to pre-curate on disk; the dashboard lets you tick and untick individual
files after it scans the folder.

## 1. Prepare your audio

Put the audio in a folder. Supported formats: WAV, FLAC, MP3, OGG, OPUS, M4A, and
AIFF.

## 2. Add metadata for prompts (optional)

Each clip can carry key-value metadata that the LoRA learns to associate with the
audio. Underfit looks in this order and uses the first source it finds:

- **JSON sidecar** — a file with the same stem as the audio and a `.json`
  extension, sitting either next to the audio (`songs/01.wav` + `songs/01.json`)
  or in a sibling `json/` folder (`songs/json/01.json`). Any string or number
  values are used:

  ```json
  {
    "title": "intrauterine fetal demise",
    "genre": "technical death metal",
    "bpm": 145,
    "mood": "absurd"
  }
  ```

- **Plain `.txt` sidecar** — the Stable Audio 3 convention. Same stem, `.txt`
  extension, next to the audio or in a sibling `txt/` folder. The whole file
  content (whitespace-stripped) becomes the `prompt` key. A dataset already
  prepared for SA3's own pre-encode script works as-is.
- **Embedded audio tags** — ID3 on MP3, Vorbis on FLAC/OGG, M4A atoms, and so on
  (`title`, `artist`, `album`, `genre`, `bpm`, `date`, `composer`, …). A library
  already tagged in Picard or Mp3tag gives you these for free.
- **No metadata** — perfectly fine. In *Configure prompts* you can build prompts
  from the file path, a fixed string, or both.

## 3. Create a dataset

Click **+ Dataset**, paste the path to your audio folder, and let the dashboard
scan it. Tick or untick files, then it spawns a GPU pre-encoding pass. Each file
becomes a `.npy` (encoded latent) plus a `.json` (metadata) pair. When the
dataset shows as ready in the **Datasets** panel it can be trained against.

> On a slow card this can take a while. The encoding panel updates as each file
> finishes.

## 4. Configure the finetune

Click **+ Finetune** and fill in the form.

| Field | What to put | Why |
|---|---|---|
| **Name** | `my-first-lora` (letters, numbers, hyphens) | Becomes the run ID and the `.safetensors` filename. |
| **Model** | `sa3-medium` | Base model to finetune against. |
| **Dataset** | the one from Step 3 | The pre-encoded latents. |
| **LoRA type** | **DoRA** | Recommended default. |
| **LoRA rank** | `16` | Capacity. Higher = more parameters, sometimes higher quality, more overfitting risk. Lower sometimes learns style better. |
| **Steps** | `20000` | A reasonable LoRA lands near 10k, where it *creatively underfits* — still varied on new prompts, not yet memorizing. Past 20k it may overfit. |
| **Batch size** | `1` on a T4, up to `8` on an H100 | Bigger uses more VRAM. |
| **Latent length** | model default, or shorter | You can train shorter than the model's max. Shorter = faster, less memorization, often better style learning. |
| **Learning rate** | leave default | Higher can learn faster but also collapse training; XS variants may need it higher. Lower can capture subtler detail. |
| **Demo every** | `500`–`1000` | How often demo audio is generated during training. |
| **Checkpoint every** | `500` | How often a `.safetensors` is saved. Every one is restartable. |

**Tips:**

- **Latent length is the underrated knob.** Lowering it to roughly 47 s or 12 s
  (with random crop on) is often the cleanest way to learn a style *without*
  memorization — the model only ever sees patterns at that timescale, never full
  songs, so it cannot memorize structure. Listen to the demos at full length to
  hear how it extrapolates.
- **Batch size is a creative parameter.** Having VRAM for 8 does not mean you
  want 8. `batch_size=1` focuses on one song at a time for a sharper imprint;
  `batch_size=4` averages gradients across songs for a smoother fit. Experiment.
- **Tune "demo every" for streaming.** A well-chosen value (around 250 on an
  H100) trains faster than you can listen, so with automatic playthrough you hear
  the model evolve continuously.

## 5. Pick a GPU

Each card shows current VRAM use and an estimate of what your run needs, based on
model, rank, and batch size. If the estimate goes red, lower batch size or rank.
The dashboard pins your choice via `CUDA_VISIBLE_DEVICES` automatically.

## 6. Configure prompts

This controls how a prompt is built from your dataset at each training step.
Three sources with balance percentages that should sum to 100:

- **Tags** — the metadata fields from Step 2 (genre, bpm, album, year, …). Toggle
  which keys to include.
- **Paths** — directory and filename. Useful when folder structure encodes
  meaning (for example `metal/death/archspire/`).
- **Fixed** — a literal string applied to every file. Use it for single-style
  datasets where every example should share one prompt.

Two more knobs: a **trigger word** optionally prepended to a percentage of
prompts, and **shuffle**, which randomizes the order of comma-separated parts
each step so the model does not memorize comma order.

- **Simplest config for a single-style dataset:** Fixed text = your trigger
  phrase, balance 100% fixed.
- **Good mix to try:** roughly 50/50 fixed plus tags (or fixed plus paths).
  Training then sees both the shared style anchor and per-song detail, so at
  inference you can use just the trigger (style only) or trigger plus details.

You are blending two prompt vocabularies. SA3's base model was trained on
labelled key-value strings like `Genre: techno, BPM: 140, Mood: dark`. Your LoRA
prompts compose on top of that vocabulary at inference time, so reusing the base
format helps the LoRA stack with what the base already knows. Skim a few of your
demo prompts to spot-check the format.

## 7. Set up demos

Demos are the MP3s and spectrograms generated during training so you can listen
as it learns. You can edit each demo's prompt text, sampler (RF or ARC), CFG,
step count, and seed; re-roll a prompt with the per-demo or global refresh
button; and add or remove demos.

## 8. Launch and watch

Click **Launch**, then:

1. The run appears in the runs panel with status `loading` while the base model
   loads into VRAM.
2. Status flips to `training` and the **Loss** curve starts plotting.
3. Every *demo every* steps the run pauses to generate demo MP3s with
   tinted-stereo spectrogram previews.
4. Every *checkpoint every* steps a fresh `.safetensors` lands in the
   **Checkpoints** list.

## 9. Know when to stop

**The loss curve.** Watch for the *elbow* — where the loss stops being flat and
begins to drop. That tends to be the most creatively underfit checkpoint and a
good one to keep. Past the elbow you creep toward memorization.

**Your ears, on the demos.** Open a demo every couple of thousand steps and
listen for:

- **Base RF demos (CFG≈7) light up first.** When the run is "getting it," the
  CFG=7 demos suddenly sound right — clearly your style on a coherent prompt.
- **Then CFG=7 over-cooks and CFG=1 takes over.** Past the elbow, CFG=7 starts
  sounding artifacted or over-saturated while the lower-CFG demos keep improving.
  When CFG=1 sounds good and CFG=7 does not, the LoRA has internalized the style
  and no longer needs prompt-classifier guidance.
- **Conditional to unconditional crossover.** Early on only prompted demos sound
  like the style; later even empty-prompt demos do — the model has absorbed the
  dataset.
- **ARC demos lag but end cleaner.** ARC-distilled demos take a few thousand more
  steps to catch up to base RF, but usually finish at higher quality.

**Do not fear a memorized checkpoint.** Overfitting only hurts if you are chasing
creative variation. A memorized checkpoint is still useful: weaken the LoRA
strength at inference, or lean on audio2audio and style transfer, where a strong
style signal pulls input audio into the training distribution more decisively.

Save checkpoints liberally — different downstream uses want different points on
the underfit-to-memorize curve. You can stop a run at any time (the last
checkpoint is yours) and resume from any checkpoint to train further.

## 10. Get the `.safetensors` out

In the **Checkpoints** list, click the download button, or grab the file
directly from `state/runs/<run-id>/<step>.safetensors`. Drop it into any SA3
inference setup and the adapter grafts onto the base model at runtime.

## Run inference with your LoRA

Click **Launch** on a checkpoint to open a Gradio inference UI, or blend several
LoRAs from the command line. The controls (LoRA strength, interval, audio2audio,
inpainting) are covered in the [Underfit tab guide](underfit.md#running-inference-from-a-checkpoint).

You can also continue training from an uploaded LoRA in *New Finetune* to fuse
styles — for example a music-style DoRA trained for 10k steps at 47 s, then
continued on a second DoRA at 12 s for a few hundred steps, yields a blend
neither dataset produces alone.

## Troubleshooting

- **Demos sound identical to the input** — overfitting too fast. Go back to an
  earlier, more interesting checkpoint, and re-run with a shorter latent length
  and random crop, or a lower rank or learning rate.
- **Demos sound nothing like the input even past 20k steps** — the dataset may be
  too varied, the rank too low, or the learning rate too low.
- **The dashboard reports the port is already in use** — another instance is
  running on `8791`. Stop it before reopening the tab.
- **A run stops unexpectedly** — training is a detached subprocess tracked in
  `runs.json`, so the run survives a closed tab or restarted server. Reopen the
  tab and the run reappears; the last saved checkpoint is intact.
