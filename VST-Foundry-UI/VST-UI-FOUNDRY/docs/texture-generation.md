# AI Texture Generation

VST Foundry can generate textures with AI and drop them straight into your project. Use it to create custom knob surfaces, panel backgrounds, brushed-metal faceplates, grunge overlays, or any other image asset, without ever leaving the app.

Generation is exposed through a **Gen** button in the Texture Library panel. Clicking it opens the generation modal, where you pick a provider, write a prompt, and generate. Finished images are added to the Texture Library automatically, ready to apply to elements like any other uploaded asset.

You can generate locally with **Stable Diffusion** or through **DALL-E**, **Gemini**, or **OpenRouter**. OpenRouter offers image models through your OpenRouter account; available models and their limits come from the provider.

---

## Quick Start

1. Open the **Texture Library** panel and click the **Gen** button in its header.
2. Select a provider tab: **Stable Diffusion**, **DALL-E**, **Gemini**, or **OpenRouter**.
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
| **Gemini** | Google cloud | Paid (Google) | Gemini key | 1–4 | Existing Imagen generation adapter |
| **OpenRouter** | OpenRouter cloud | Paid (OpenRouter) | OpenRouter key | 1–4 | Catalog-selected image models through one account |

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

## Gemini (Google)

The Google provider runs in Google's cloud and requires no local install.

The Generate modal currently uses the existing Imagen `:predict` adapter, with `imagen-3.0-generate-002` as its default. It forwards the image count as `sampleCount`; it does not forward the shared size field. This change does not migrate that adapter. Use the OpenRouter tab to choose from its image model catalog, including Gemini image models when available.

**Requirements:** a Gemini API key, configured in the AI Assistant settings (see [Cloud Providers — API Keys](#cloud-providers--api-keys)).

**Options:**

| Option | Values | Notes |
|--------|--------|-------|
| **Count** | 1–4 images | Number of variations per generation |

---

## OpenRouter

The **OpenRouter** tab loads its model picker through `/api/textures/openrouter-image-models`. The catalog is fetched without credentials and prefers a Gemini image model when one is available; another catalog model can be selected manually.

Generation calls OpenRouter's dedicated `/api/v1/images` endpoint with the selected model, prompt, count (`n`), and size (`size`). The app accepts counts from **1–4**. Model support for counts and dimensions varies; upstream errors are shown instead of silently changing the request. If a successful response contains fewer or more images than requested, generation fails with both counts rather than saving an incomplete result.

An HTTP **404/405** stops generation with an actionable error. Chat-completions fallback is disabled because it cannot guarantee the requested count and size. No second generation request is made. Ordinary provider errors are surfaced with the submitted key redacted, and requests time out after five minutes.

The model catalog is cancelled when leaving the tab or closing the modal; late responses cannot replace a newer selection. Entering another cloud tab selects that provider's own key override.

Verified against the official [image generation API](https://openrouter.ai/docs/api/api-reference/images/generate-an-image) and [image model discovery guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) on 2026-09-13. OpenRouter defines `n` as an upper bound; the app intentionally requires the requested count before saving. A rejected partial response may still have incurred provider charges.

Implementation: `server/features/openrouter/` owns generation, catalog routes, extraction dispatch, schema conversion, and expanded extractor prompts. `src/features/openrouter-textures/` owns the model picker, catalog lifecycle, provider key isolation, request extensions, and synthetic tests. Shared files contain explicit integration hooks.

Focused offline regression command, from `VST-Foundry-UI/VST-UI-FOUNDRY`:

```sh
npx --no-install vitest run src/features/openrouter-textures --maxWorkers=1
```

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

Each cloud tab has an optional key override. Overrides stay with their provider while switching tabs and are cleared when the modal closes.

- **DALL-E:** override, then the server's `OPENAI_API_KEY`.
- **Gemini:** override, then the server's `GEMINI_API_KEY`.
- **OpenRouter:** override, then the assistant's saved `openrouter` key, then the server's `OPENROUTER_API_KEY`.

The saved OpenRouter key is read from browser local storage when constructing each request, so updates and removals take effect without reopening the modal. Blocked or malformed storage falls back to the server key. Assistant-saved keys can persist across browser sessions; the generation modal does not write key overrides to storage.

---

## Where Generated Textures Are Saved

The Generate modal writes each returned image into the Texture Library:

| Stage | Location | Served At |
|-------|----------|-----------|
| **Library output** | `./data/textures/<uuid>.png` | `/textures/<uuid>.png` |

The existing saver decodes returned base64 bytes and writes them under a `.png` filename; it does not re-encode image formats. The new provider uses that same save path.

Both `./data/generated/` and `./data/textures/` are **gitignored**, so generated assets never get committed to version control by accident.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| SD won't connect | `--nowebui` is in Extra Args | Remove it; keep `--api` for A1111. |
| SD won't connect | Wrong port | Confirm 7860 (A1111) or 8188 (ComfyUI), matching your install. |
| Wrong / no Python found | Python Path manually set incorrectly | Clear the field and let the app auto-detect from the venv. |
| No checkpoints listed | Model Library Directory not set (A1111) | Point it at your checkpoints folder (`Data/Models/Stable-diffusion` for SM). |
| Cloud generation fails | Missing API key | Enter the matching tab's override or configure its server environment key. OpenRouter also reads the assistant's saved key. |
| OpenRouter images endpoint unavailable | HTTP 404/405 | Check the selected model and OpenRouter endpoint availability; the app stops before a fallback can drop count or size. |
| OpenRouter returned a different image count | Provider generated a partial batch | Request a supported count or select a model that supports that batch size. |
| Orphaned GPU process | — | Not an issue here: SD is auto-killed when the app server closes. |

---

## See Also

- [AI Assistant Orchestrator](./ai-assistant.md) — where your OpenAI and Gemini API keys are configured.
- [Styling and Themes](./styling-and-themes.md) — applying textures to elements once they're in the library.
