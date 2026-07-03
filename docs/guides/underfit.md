# Underfit — LoRA Trainer Guide

Reference for theDAW's **Underfit** tab: a power-user dashboard for training
custom LoRA finetunes of Stable Audio 3 and running inference on them. You point
it at a folder of audio, pre-encode it into latents, configure a finetune, and
watch it train with live loss curves and audio demos. Plain descriptions of what
each piece does.

Underfit is a vendored standalone app (the underfit dashboard) embedded inside
theDAW. It runs as its own small server and shows up as a regular center tab —
you do not launch or manage it separately.

For the end-to-end walkthrough of training a LoRA, see the
[Underfit LoRA training walkthrough](underfit-lora-training.md). For the model
internals behind the adapter types, see theDAW's
[LoRA guide](../workflows/lora.md).

## Opening Underfit

Click the **Underfit** tab in the center tab bar (alongside MAKE, MIX, DJ, and
the other center tabs). theDAW serves the dashboard on
`http://localhost:8791` and embeds it in the tab. Inside theDAW the model packs
and Python environment are already provisioned, so there is no install,
Hugging Face login, or download step — you go straight to creating a dataset.

> The standalone underfit project defaults to port `8787`; inside theDAW it runs
> on `8791` so it does not collide with other local services.

## Requirements and hardware

Training is GPU-only. The dashboard estimates the VRAM a run will need from the
model, rank, and batch size, and warns before you launch if the estimate exceeds
the card you picked.

| GPU tier | Fit | Notes |
|---|---|---|
| H100 (80 GB) | Yes | Very fast. Holds many finetunes per card. |
| A100 / L4 / 4090 | Yes | Comfortable. |
| T4 (16 GB) | Limited | Slow but works; expect patience. |
| CPU only | No | Will not train. |

- **VRAM** — 16 GB or more is ideal. 8 GB still trains with minimal settings:
  fp16 base model, low rank, small latent crop, batch 1.
- **Disk** — the SA3 model packs are already present under `F:\huggingface`, so
  they cost you nothing extra. Each dataset adds a few hundred MB of encoded
  latents, and every checkpoint you keep is another `.safetensors` on disk.

The user's RTX 4090 (24 GB) sits in the "comfortable" tier and trains all three
model packs without special measures.

## Supported models

Each pack has a **Base** (rectified-flow, 50-step) checkpoint and an **ARC**
(adversarial-consistency, 8-step) checkpoint. Underfit trains LoRAs on the
**Base** model only; the trained adapter then works on the ARC model at inference
time. During training the dashboard generates demos with both.

| Pack | Trained duration | Best for |
|---|---|---|
| `sa3-medium` | 6:20 | General music and SFX. Best quality. |
| `sa3-sm-music` | 2:00 | Music-focused, smaller and faster. |
| `sa3-sm-sfx` | 2:00 | Sound-effects-focused, smaller and faster. |

## Adapter formats

Pick one in the **LoRA type** dropdown of *New Finetune*. Every variant produces
a single `.safetensors` file you can load anywhere. Throughout Underfit, "LoRA"
is used as a catch-all for the whole adapter family.

| Format | What it adds | When to use |
|---|---|---|
| **LoRA** | `lora_A`, `lora_B` low-rank matrices | The original adapter. Well understood, less expressive. |
| **DoRA** | LoRA plus a magnitude vector | Recommended default. Generally better-quality fits than plain LoRA. |
| **BoRA** | LoRA plus per-row *and* per-column magnitudes | Like DoRA but scales in both dimensions. |
| **LoRA-XS / DoRA-XS / BoRA-XS** | The rank matrices are factored against fixed SVD bases instead of being free parameters | "Extra-small" variants. Smaller files, slightly less capacity. |

theDAW's [LoRA guide](../workflows/lora.md) covers the math behind each adapter
type and the per-layer parameter counts.

## The workspace

The dashboard is organized around three lists — datasets, finetune runs, and
checkpoints — plus live telemetry for the selected run.

- **Datasets panel** — the folders of audio you have pre-encoded into latents.
  Click **+ Dataset**, paste a path, tick or untick individual files after the
  scan, and the dashboard spawns a GPU pre-encoding pass. Each audio file becomes
  a `.npy` latent plus a `.json` metadata pair. Supported input formats: WAV,
  FLAC, MP3, OGG, OPUS, M4A, AIFF. Encoding is multi-GPU sharded when more than
  one card is present.
- **New Finetune** — the form that configures and launches a run: name, model,
  dataset, LoRA type, rank, steps, batch size, latent length, learning rate,
  demo/checkpoint frequency, prompt sources, and demo setup. See the
  [training walkthrough](underfit-lora-training.md) for what to put in each field.
- **Runs panel** — every finetune, past and present, with its status
  (`loading`, `training`, stopped). Runs are detached subprocesses managed by the
  dashboard, so closing the tab or restarting the server does not kill training.
- **Telemetry charts** — for the selected run: **Loss**, **Loss by Noise Level**
  (splits the loss across the diffusion sigma range), **Grad Norm**, **LoRA
  Magnitude**, and **Learning Rate**.
- **Audio Demos** — MP3s with tinted-stereo spectrogram previews, regenerated
  every *demo every* steps so you can hear the LoRA learn. You can edit a demo's
  prompt, sampler (RF or ARC), CFG, steps, and seed, and re-roll prompts.
- **Checkpoints** — the `.safetensors` files saved every *checkpoint every*
  steps. Download one with the ⬇ button, launch inference on it, or resume
  training from it.
- **Select GPU** — each card shows current VRAM use and an estimate of the run's
  needs. If the estimate goes red, lower batch size or rank. The chosen GPU is
  pinned via `CUDA_VISIBLE_DEVICES` automatically.

## Running inference from a checkpoint

Click **Launch** on any checkpoint to spin up a private Gradio inference UI for
it. Controls:

- **LoRA strength** — below 1.0 blends the LoRA with the base model. A heavily
  trained checkpoint often sounds best around 0.6–0.8: "in the style of" without
  straight regurgitation.
- **LoRA interval (skip first step)** — the first denoising step sets song
  structure, so skipping the LoRA there lets the base model shape structure from
  the prompt while the LoRA supplies style.
- **audio2audio** — drop in a song and let SA3 plus your LoRA restyle it.
- **Inpainting** — paint over a region of an input and regenerate just that
  region in the LoRA's style.

To blend several LoRAs at once, pass multiple files on the command line:

```bash
run_gradio.py \
    --model-config state/models/sa3-medium/base/model_config.json \
    --ckpt-path    state/models/sa3-medium/base/model.safetensors \
    --lora-ckpt-path lora_a.safetensors lora_b.safetensors
```

LoRA strengths interact non-linearly, so blends are worth experimenting with.

## Operational notes

- **The dashboard runs on port `8791`** inside theDAW. If the tab reports the
  port is already in use, another instance is running; stop it before reopening.
- **Runs survive disconnects.** Training is a detached subprocess tracked in
  `runs.json`; the dashboard re-reads it on launch, so a closed tab or restarted
  server does not end a run.
- **Checkpoints live on disk** under `state/runs/<run-id>/<step>.safetensors`.
  You can grab them directly, or use the download button in the Checkpoints list.
- **Resume any time.** Upload an existing `.safetensors` in *New Finetune* to
  continue training from it, mixing datasets or styles iteratively.
