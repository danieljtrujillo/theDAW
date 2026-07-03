# AI Texture Generation

VST Foundry can generate textures with AI and drop them straight into your project. Use it to create custom knob surfaces, panel backgrounds, brushed-metal faceplates, grunge overlays, or any other image asset, without ever leaving the app.

Generation is exposed through a **Gen** button in the Texture Library panel. Clicking it opens the generation modal, where you pick a provider, write a prompt, and generate. Finished images are added to the Texture Library automatically, ready to apply to elements like any other uploaded asset.

You can generate locally with **Stable Diffusion** (free, runs on your own GPU) or through a cloud provider (**DALL-E** or **Gemini / Nano Banana**).

---

## Quick Start

1. Open the **Texture Library** panel and click the **Gen** button in its header.
2. Select a provider tab: **Stable Diffusion**, **DALL-E**, or **Gemini**.
3. Enter a prompt describing the texture you want.
4. Click **Generate**.
5. The finished image(s) appear in the **Texture Library** automatically.

That's the whole loop. Everything below covers provider setup, options, and where files land on disk.

---

## Providers at a Glance

| Provider | Runs | Cost | API Key | Image Count | Best For |
|----------|------|------|---------|-------------|----------|
| **Stable Diffusion** | Locally (your GPU) | Free | None | Batch via queue | Full control, custom models, LoRAs, offline use |
| **DALL-E** | OpenAI cloud | Paid (OpenAI) | OpenAI key | 1–4 | Fast, high-quality results with zero setup |
| **Gemini / Nano Banana** | Google cloud | Paid (Google) | Gemini key | 1–4 | Photorealistic textures, natural-language edits, zero setup |

---

## Stable Diffusion (Local)

Stable Diffusion runs on your own machine, so generation is free and works fully offline once set up. VST Foundry supports two backends:

- **A1111 / Forge / Neo** — the AUTOMATIC1111 WebUI and its compatible forks.
- **ComfyUI** — the node-based backend.

### The App Manages the SD Process

You do **not** need to start Stable Diffusion yourself. VST Foundry launches, monitors, and shuts down the SD process for you:

- A **Start / Stop** button in the Generate modal controls the SD process directly.
- Enable **Auto-start** (see settings below) to launch SD automatically the moment the Generate modal opens.
- When you close the app server, any SD process it started is **automatically killed**, so you never leave an orphaned GPU process running.

### Batch Generation

Stable Diffusion supports **batch generation with a queue**. Submit multiple prompts or a high batch count and the app processes them in order, adding each finished image to the Texture Library as it completes.

---

## DALL-E (OpenAI)

DALL-E runs in OpenAI's cloud, so there is nothing to install. It supports **DALL-E 3** and **DALL-E 2**.

**Requirements:** an OpenAI API key, configured in the AI Assistant settings (see [Cloud Providers — API Keys](#cloud-providers--api-keys)).

**Options:**

| Option | Values | Notes |
|--------|--------|-------|
| **Count** | 1–4 images | Number of variations per generation |
| **Size** | Standard sizes | Output resolution / aspect |
| **Quality** | `standard`, `hd` | `hd` produces finer detail |
| **Style** | `vivid`, `natural` | `vivid` is more stylized; `natural` is more true-to-prompt |

---

## Gemini / Nano Banana (Google)

The Google provider runs in Google's cloud and requires no local install.

> **Deprecation notice:** the legacy **Gemini Imagen** models (`imagen-3.0-generate-002` and other Imagen models) are **deprecated as of 2026-08-17**. Migrate to the **Gemini / Nano Banana** provider, which supersedes Imagen for texture generation and also unlocks natural-language image editing (see the **editTexture** tool in *Advanced Generation & Editing* below).

**Requirements:** a Gemini API key, configured in the AI Assistant settings (see [Cloud Providers — API Keys](#cloud-providers--api-keys)).

**Options:**

| Option | Values | Notes |
|--------|--------|-------|
| **Count** | 1–4 images | Number of variations per generation |

---

## Stable Diffusion — Setup

Configure Stable Diffusion under **Settings → Stable Diffusion**. You only need to do this once.

| Setting | Description |
|---------|-------------|
| **Preferred Engine** | Choose **A1111** or **ComfyUI**. |
| **Executable Path** | Path to `launch.py` (A1111) or `main.py` (ComfyUI). |
| **Port** | The port SD listens on. Default **7860** for A1111, **8188** for ComfyUI. |
| **Extra Args** | Launch arguments. Default `--api` for A1111. |
| **Python Path** | Leave blank. Auto-detected from the `venv` next to the script. |
| **Model Library Directory** | Folder containing your checkpoint `.safetensors` files. |
| **Output Directory** | Optional. Where SD writes its raw outputs. |
| **Auto-start** | Launch SD automatically when the Generate modal opens. |

*Tip:* For A1111, keep `--api` in **Extra Args** so VST Foundry can talk to the WebUI. **Do not** add `--nowebui` — it changes the default port behavior and breaks the connection.

*Tip:* Leave **Python Path** blank. The app finds the correct interpreter from the `venv` that sits alongside your launch script, which is almost always what you want.

---

## Stability Matrix Users

If you manage Stable Diffusion with **Stability Matrix (SM)**, setup is essentially automatic.

1. Point the **Executable Path** at the package's `launch.py` (A1111) or `main.py` (ComfyUI) inside your SM `Data/Packages` folder.
2. Leave **Python Path** blank. VST Foundry automatically detects the correct Python interpreter from the package's own virtual environment, located at `venv/Scripts/python.exe` alongside the script. No manual Python configuration is needed.

**For the Model Library Directory:**

- **A1111:** point it at your SM shared models folder for checkpoints — `Data/Models/Stable-diffusion`.
- **ComfyUI:** no model directory configuration is needed. ComfyUI finds its models automatically through the `extra_model_paths.yaml` that Stability Matrix generates for you.

---

## Advanced Mode (Stable Diffusion Only)

Toggle **Advanced** in the Generate modal to unlock fine-grained control over the diffusion process. These options apply to Stable Diffusion only.

| Setting | Description | Default |
|---------|-------------|---------|
| **Model** | Select from available checkpoints. Fetched from the A1111 API, or scanned from the Model Library Directory. | — |
| **VAE** | Select the VAE (A1111 API). | — |
| **LoRAs** | Add multiple LoRAs, each with its own weight (**0.1–1.5**). | — |
| **Steps** | Number of denoising steps. | 20 |
| **CFG Scale** | Classifier-free guidance strength. | 7 |
| **Sampler** | Sampling algorithm (e.g. Euler a, DPM++ 2M Karras). | — |
| **Seed** | `-1` for random, or a specific integer for reproducible results. | -1 |
| **Batch Count** | Number of images to generate in one run. | — |

### How LoRA Weights Work

When you add LoRAs, VST Foundry embeds them into the prompt using A1111 syntax. A LoRA named `brushed_metal` at weight `0.8` is injected as:

```text
<lora:brushed_metal:0.8>
```

Add several LoRAs and each one is appended in the same form, so you can stack styles and balance their influence with the weight.

*Tip:* Set a fixed **Seed** (any integer other than `-1`) when you want to reproduce an exact result or compare the effect of changing a single parameter. Use `-1` while you are still exploring.

---

## Advanced Generation & Editing

Beyond plain text-to-image generation, VST Foundry exposes a set of tools for editing, refining, upscaling, varying, and batching textures, plus structural conditioning. Provider support varies per tool — each tool below lists which providers it works with.

### editTexture — img2img & Inpainting

Modify an **existing** texture using a text prompt, instead of generating from scratch.

- Feed in a source image plus a prompt to transform it (img2img).
- Optionally supply a **mask** (a PNG whose **transparent areas mark the regions to regenerate**). Without a mask the whole image is reworked; with a mask only the masked regions change (inpainting).
- **Providers:** A1111, ComfyUI (img2img API), OpenAI `gpt-image-1` (`/v1/images/edits`), Gemini (natural-language edits — **no mask required**), OpenRouter.

| Option | Applies To | Notes |
|--------|-----------|-------|
| **denoisingStrength** (0–1) | SD providers (A1111 / ComfyUI) | How much to change vs. preserve. Low = subtle tweak, high = heavy reinterpretation. |
| **inputFidelity** | OpenAI only | Preserves faces and fine detail in the source while editing. |

### upscaleTexture — Super-Resolution

Upscale a texture **2x or 4x** for higher-resolution output.

- **A1111:** uses the extras API (`/sdapi/v1/extra-single-image`) with upscaler models such as `ESRGAN_4x`, `R-ESRGAN 4x+`, or `4x-UltraSharp`.
- **ComfyUI:** uses `UpscaleModelLoader` + `ImageUpscaleWithModel` nodes.
- **Optional face restoration:** `GFPGAN` or `CodeFormer` to clean up faces during the upscale.

### generateTextureVariations

Create multiple **variations** of an existing texture while keeping its overall character.

- **A1111 / ComfyUI:** subseed variation, controlled by **variationStrength** (0–1).
- **OpenAI:** `/v1/images/variations` (DALL-E 2), or the edits endpoint for `gpt-image` models.
- Specify a **count** (1–10) and the variation strength.

### batchGenerateTextures

Generate **multiple textures from different prompts in a single call**.

- Each request in the batch carries its own **prompt**, **seed**, and **dimensions**.
- **commonParams** apply to every request in the batch (e.g. model, sampler), so shared settings are specified once.

### controlNetGenerate — Structural Conditioning

Provide a **reference image** that guides the structure of the generated texture.

- **Providers:** A1111 / ComfyUI only.
- **Modules:** `canny` (edge detection), `depth` (depth map), `openpose` (pose), `lineart`, `scribble`, `tile`, `seg`, `normal_map`.
- **controlNetWeight** (0–2) controls how strongly the reference image influences the result.

---

## Cloud Providers — API Keys

DALL-E and Gemini use the **same API keys as the AI Design Assistant**. There is no separate key entry for texture generation.

- Configure your **OpenAI** and **Gemini** keys in the **AI Assistant settings panel** — open it from the floating assistant orb.
- Keys are stored **per-session** and are **never written to disk**.

Because keys live only for the session, you re-enter them when you start a fresh session. This keeps your credentials out of any saved file or project export.

---

## Where Generated Textures Are Saved

Every generated image is written to two places:

| Stage | Location | Served At |
|-------|----------|-----------|
| **Raw output** | `./data/generated/<uuid>.png` | — |
| **Library copy** | `./data/textures/<uuid>.png` | `/textures/<uuid>.png` |

When generation finishes, the raw output is auto-copied into the textures folder, where it becomes part of the Texture Library and is served to the app at `/textures/<uuid>.png`.

Both `./data/generated/` and `./data/textures/` are **gitignored**, so generated assets never get committed to version control by accident.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| SD won't connect | `--nowebui` is in Extra Args | Remove it; keep `--api` for A1111. |
| SD won't connect | Wrong port | Confirm 7860 (A1111) or 8188 (ComfyUI), matching your install. |
| Wrong / no Python found | Python Path manually set incorrectly | Clear the field and let the app auto-detect from the venv. |
| No checkpoints listed | Model Library Directory not set (A1111) | Point it at your checkpoints folder (`Data/Models/Stable-diffusion` for SM). |
| Cloud generation fails | Missing API key | Add the OpenAI / Gemini key in the AI Assistant settings (orb). |
| Orphaned GPU process | — | Not an issue here: SD is auto-killed when the app server closes. |

---

## See Also

- [AI Assistant Orchestrator](./ai-assistant.md) — where your OpenAI and Gemini API keys are configured.
- [Styling and Themes](./styling-and-themes.md) — applying textures to elements once they're in the library.
