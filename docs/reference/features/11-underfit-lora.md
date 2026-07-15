## UNDERFIT — LoRA finetune training dashboard

UNDERFIT is theDAW's in-app dashboard for training your own **LoRA / DoRA adapters on Stable Audio 3**, contributed by [dadabots](https://dadabots.com). It is vendored as a git-subrepo at `underfit/` with its own Python venv, and theDAW embeds its standalone web dashboard directly in a center tab.

### How it's wired

- **Frontend tab** (`frontend/src/views/UnderfitView.tsx`) embeds the dashboard (a raw `http.server` control plane on `http://localhost:8791`) in an iframe. It pings the server every 3 s and only mounts the iframe once it answers, so a not-yet-started server shows a "connecting" / install-fix overlay instead of a dead page.
- **Backend sidecar** (`backend/modules/underfit/`) auto-spawns the dashboard at startup, can build its venv on demand (`uv sync --inexact`), start/stop it, and self-update from `dada-bots/underfit` via `git-subrepo`. Stopping the dashboard deliberately does **not** kill training runs — they run as detached subprocesses that survive restarts.

### What you can do

- **Pre-encode a folder of audio** (WAV/FLAC/MP3/OGG/OPUS/M4A/AIFF) into VAE latents, with prompts composed from JSON/`.txt` sidecars, embedded tags (via `audio_metadata`), file paths, or fixed trigger strings. An autotagger can derive artist/album/genre sidecars from folder structure.
- **Train an adapter** with a raw-PyTorch loop: choose **LoRA, DoRA, BoRA**, or their SVD-factored **-XS** variants. The base diffusion transformer and T5Gemma conditioner are frozen; only the adapter trains. Live **loss curves**, a **loss-by-timestep** chart, checkpoint-every saves, SIGUSR1 manual save, and resume-from-checkpoint are built in.
- **Hear it train**: every N steps it renders **demo MP3s** (RF and ARC samplers, editable prompt/CFG/seed) with tinted-stereo spectrograms.
- **Run inference per checkpoint** via a one-click **Gradio** UI — LoRA strength <1.0 blending, skip-LoRA-on-early-steps, audio2audio, inpainting, and multi-LoRA blend.
- **Optional AI assistant orb** bundled into the dashboard (Express backend on :5473), with Anthropic/Gemini/OpenAI/Grok/Groq providers and local voice input.

### Models

| Pack | Base (RF, 50-step) | ARC (adversarial, 8-step) |
|---|---|---|
| `sa3-medium`   | `stabilityai/stable-audio-3-medium-base` | `stabilityai/stable-audio-3-medium` |
| `sa3-sm-music` | `stabilityai/stable-audio-3-small-music-base` | `stabilityai/stable-audio-3-small-music` |
| `sa3-sm-sfx`   | `stabilityai/stable-audio-3-small-sfx-base` | `stabilityai/stable-audio-3-small-sfx` |

Text conditioning uses **`google/t5gemma-b-b-ul2`** (underfit also allowlists `stabilityai/t5gemma-b-b-ul2` for SAT-dev configs); the SA3 packs bundle the tokenizer. LoRA training runs on the **base** model; the resulting adapter works with the **ARC** model for fast inference. The optional assistant orb defaults to **`claude-opus-4-8`** and can also use `gemini-3.5-flash`, `gpt-4.1-mini`, `grok-3-mini-fast`, or Groq `llama-3.3-70b-versatile`; its voice transcription is local via **faster-whisper**.

### Runs on modest hardware

- **Streaming checkpoint load** (tensor-by-tensor via `safetensors` + `accelerate`) cuts peak CPU RAM for SA3-medium from ~14 GB to ~6 GB — enough to load on a 13 GB Colab T4.
- **Adapter-only training** keeps trainable params and optimizer state tiny; base stays frozen at fp16/bf16 while LoRA params train in fp32.
- **fp16/bf16 mixed precision**, optional 8-bit (`bitsandbytes AdamW8bit`) / fused (`deepspeed FusedAdam`) optimizers, DataLoader `num_workers` auto-capped to host CPUs with `pin_memory` + `persistent_workers`.
- **Tiny-dataset oversampling** (RandomSampler with replacement + random crop) makes a 1-file dataset train sensibly.
- Documented **8 GB-VRAM minimal recipe**: fp16 base + low rank + small latent crop + batch 1.

### Offline / cloud

Training and inference are **fully local** on an NVIDIA GPU — no cloud inference. The only network dependency is a one-time gated **HuggingFace** download of the SA3 packs (free account + one license-accept click); afterward the shared HF cache runs offline. CPU-only and Mac/MPS are documented as won't-train. The assistant orb's cloud LLM providers need API keys, but the trainer itself never calls a cloud LLM.
