# Underfit LoRA Trainer Guide

Reference for theDAW's **Underfit** tab, a dashboard for training custom LoRA
finetunes of Stable Audio 3 and running inference on them. The workflow points
Underfit at a folder of audio, pre-encodes it into latents, configures a
finetune, and runs training with live loss curves and audio demos. Each section
below states what a piece does and where it lives.

Underfit is a vendored standalone app (the underfit dashboard) embedded inside
theDAW. It runs as its own server and appears as a regular center tab. theDAW
launches and manages it, so it does not have to be started separately.

For the end-to-end walkthrough of training a LoRA, see the
[Underfit LoRA training walkthrough](underfit-lora-training.md). For the model
internals behind the adapter types, see theDAW's
[LoRA guide](../workflows/lora.md).

## Opening Underfit

Click the **Underfit** tab in the center tab bar, alongside MAKE, MIX, DJ, and
the other center tabs. theDAW serves the dashboard on `http://localhost:8791`
and embeds it in the tab.

Underfit runs in its **own** Python environment, separate from theDAW's. On first
use the tab offers to build it (**Create environment**); this is a one-time
`uv sync` that downloads roughly 2.5 GB of torch + torchaudio and takes 10–30
minutes. Leave theDAW open while it runs — quitting midway leaves a half-built
environment, which the tab now detects and offers to **Repair**. Training itself
needs a CUDA GPU. The model packs download later, on demand, and the SA3
checkpoints they wrap are gated on Hugging Face, so you may be asked to sign in
(the app raises a sign-in card when a download is refused). Once the dashboard
is up, the first action is creating a dataset.

> The standalone underfit project defaults to port `8787`. Inside theDAW it runs
> on `8791` so it does not collide with other local services.

## Requirements and hardware

Training requires a CUDA GPU. The dashboard estimates the VRAM a run will need
from the model, rank, and batch size, and warns before launch when the estimate
exceeds the selected card.

| GPU tier | Fit | Notes |
|---|---|---|
| H100 (80 GB) | Yes | Fast. Fits several finetunes per card. |
| A100 / L4 / 4090 | Yes | Comfortable. |
| T4 (16 GB) | Limited | Trains slowly. |
| CPU only | No | Will not train. |

- **VRAM.** 16 GB or more is comfortable. 8 GB still trains with minimal
  settings: fp16 base model, low rank, small latent crop, batch 1.
- **Disk.** The SA3 model packs live in the standard Hugging Face cache, so they
  add no extra space. Each dataset adds a few hundred MB of encoded latents, and
  every checkpoint kept is another `.safetensors` file on disk.

A CUDA card with 24 GB of VRAM sits in the "comfortable" tier and trains all
three model packs without special measures.

## Supported models

Each pack has a **Base** checkpoint (rectified-flow, 50-step) and an **ARC**
checkpoint (adversarial-consistency, 8-step). Underfit trains LoRAs on the
**Base** model. The trained adapter then works on the ARC model at inference
time. During training the dashboard generates demos with both.

| Pack | Trained duration | Best for |
|---|---|---|
| `sa3-medium` | 6:20 | General music and SFX. Best quality. |
| `sa3-sm-music` | 2:00 | Music-focused, smaller and faster. |
| `sa3-sm-sfx` | 2:00 | Sound-effects-focused, smaller and faster. |

## Adapter formats

Pick one in the **LoRA type** dropdown of *New Finetune*. Every variant produces
a single `.safetensors` file that loads anywhere. Throughout Underfit, "LoRA" is
used as a catch-all for the whole adapter family.

| Format | What it adds | Notes |
|---|---|---|
| **LoRA** | `lora_A`, `lora_B` low-rank matrices | The original adapter. Less expressive. |
| **DoRA-rows** | LoRA plus an output-dimension magnitude vector | Recommended default. The Standard and High-capacity presets select it. |
| **DoRA-cols** | LoRA plus an input-dimension magnitude vector | DoRA scaled on the input dimension. |
| **BoRA** | LoRA plus both output- and input-dimension magnitudes | Scales in both dimensions. |
| **LoRA-XS / DoRA-rows-XS / DoRA-cols-XS / BoRA-XS** | The rank matrices are factored against fixed SVD bases instead of free parameters | Smaller files, slightly less capacity. |

theDAW's [LoRA guide](../workflows/lora.md) covers the math behind each adapter
type and the per-layer parameter counts.

## The workspace

The dashboard is organized around three lists (datasets, finetune runs, and
checkpoints) plus live telemetry for the selected run.

- **Datasets panel.** The folders of audio pre-encoded into latents. Click
  **NEW DATASET**, paste a path, tick or untick individual files after the scan,
  and the dashboard runs a GPU pre-encoding pass. Each audio file becomes a
  `.npy` latent plus a `.json` metadata pair. Supported input formats: WAV,
  FLAC, MP3, OGG, OPUS, M4A, AIFF. Encoding is multi-GPU sharded when more than
  one card is present.
- **New Finetune.** The form that configures and launches a run: name, model,
  dataset, LoRA type, rank, steps, batch size, latent length, learning rate,
  demo/checkpoint frequency, prompt sources, and demo setup. See the
  [training walkthrough](underfit-lora-training.md) for each field.
- **Runs panel.** Every finetune, past and present, with its status (`loading`,
  `training`, stopped). Runs are detached subprocesses managed by the dashboard,
  so closing the tab or restarting the server does not stop training.
- **Telemetry charts.** For the selected run: **Loss**, **Loss by Noise Level**
  (splits the loss across the diffusion sigma range), **Grad Norm**, **LoRA
  Magnitude**, and **Learning Rate**.
- **Audio Demos.** MP3 previews with tinted-stereo spectrograms, regenerated
  every *demo every* steps so the LoRA's progress can be heard. The demos
  produced at each step are defined in the New Finetune Demos setup, where each
  demo carries its own prompt, sampler (RF or ARC), CFG, steps, and seed, and a
  control regenerates all prompts at once.
- **Checkpoints.** The `.safetensors` files saved every *checkpoint every*
  steps. Each row has a download button, a control to launch inference, and a
  control to resume training from it.
- **Select GPU.** Each card shows current VRAM use and an estimate of the run's
  needs. When the estimate turns red, lower batch size or rank. The chosen GPU
  is pinned via `CUDA_VISIBLE_DEVICES` automatically.

## Running inference from a checkpoint

Click **Launch** on any checkpoint to start a private Gradio inference UI for it.
Controls:

- **strength.** The per-LoRA strength slider inside each LoRA's accordion. Below
  1.0 it blends the LoRA with the base model. A heavily trained checkpoint often
  sounds best around 0.6 to 0.8, close to the training style without direct
  copying.
- **Interval min / Interval max.** The denoising interval over which the LoRA is
  active, from 0 to 1. The first denoising step sets overall structure, so
  raising Interval min lets the base model shape structure from the prompt while
  the LoRA supplies style over the rest of the run.
- **Init audio.** An audio upload in the Init audio accordion. Load a song and
  generate a variation of it with the base model plus the LoRA. An Init noise
  level slider controls how much of the input is kept.
- **Inpainting.** Upload audio, set a mask region with the start and end
  sliders, and regenerate just that region in the LoRA's style.

To blend several LoRAs at once, pass multiple files to `--lora-ckpt-path` on the
command line:

```bash
run_gradio.py \
    --model-config <model_config.json> \
    --ckpt-path    <base_model.safetensors> \
    --lora-ckpt-path lora_a.safetensors lora_b.safetensors
```

LoRA strengths interact non-linearly, so blends are worth testing by ear.

## Operational notes

- **The dashboard runs on port `8791`** inside theDAW. When the tab reports the
  port is already in use, another instance is running; stop it before reopening.
- **Runs survive disconnects.** Training runs as a detached subprocess tracked
  in `runs.json`. The dashboard re-reads that file on launch, so a closed tab or
  restarted server does not end a run.
- **Checkpoints live on disk** under the run's checkpoints folder in
  `state/runs`, named `step=<step>-epoch=<epoch>.safetensors`. Copy them
  directly, or use the download button in the Checkpoints list.
- **Resume at any time.** Upload an existing `.safetensors` in *New Finetune* to
  continue training from it, mixing datasets or styles across runs.
