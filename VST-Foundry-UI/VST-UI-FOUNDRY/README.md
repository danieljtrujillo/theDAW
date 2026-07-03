# VST UI Foundry

```text
____   ____ ___________________   ___________                  .___             
\   \ /   //   _____/\__    ___/   \_   _____/___  __ __  ____ |   |_______ ___.__.
 \   Y   / \_____  \   |    |       |    __)/  _ \|  |  \/    \|   |\_  __ <   |  |
  \     /  /        \  |    |       |     \(  <_> )  |  /   |  \   | |  | \/\___  |
   \___/  /_______  /  |____|       \___  / \____/|____/|___|  /___| |__|   / ____|
                  \/                    \/                   \/             \/     
```

**VST UI Foundry** is a browser-based, drag-and-drop UI builder for audio plugin interfaces (VST, AU, AAX) and web-audio apps — with a multi-provider AI co-designer that can read, build, and restyle your canvas for you.

Stop wrestling with pixel coordinates in C++ or writing boilerplate UI code. Design your synth, effect, or utility visually, talk to an AI that has direct control over the canvas, generate your own textures, and export production-ready code.

React 19 SPA served by Express 5 on port `3000`.

## 🚀 Features

### Multi-Provider AI Co-Designer
- **9 AI providers, one assistant:** Google Gemini, OpenAI, Anthropic, xAI Grok, Groq, OpenRouter, OpenRouter Free, Ollama (local), and LM Studio (local). Switch providers and models on the fly.
- **Claude Code CLI provider:** drives the assistant through the locally installed `claude` CLI with full MCP tool access (see [Claude Code Provider](#-claude-code-provider--mcp-relay) below).
- **Live model discovery:** models are fetched per provider at runtime — no hardcoded model lists to go stale.
- **Direct canvas control:** 37 tools total — 22 canvas/app actions (add, move, style, align, theme, delete elements), web page fetching, 9 texture tools, and 5 generation/edit tools.
- **Multimodal & vision-aware:** drop in image references or have the AI take canvas screenshots to inspect and refine alignment, palettes, and glow spread.
- **Bring-your-own keys:** per-provider API keys are stored in-app; server-side `.env` keys act as a fallback. Ollama and LM Studio need no key at all.

### Drag-and-Drop Canvas
- **Element types:** Knob, Slider, Button, Toggle, Meter, Waveform, XY Pad, ValueBox, Label, Image, Group, and **CustomCode** (a sandboxed iframe that runs your own JS).
- **Procedural glow engine:** Outer Glow, Inner Glow, and Center (volumetric) Glow, plus contoured PNG drop-shadows that trace transparent/chroma-keyed image shapes pixel-perfectly.
- **Style variants & continuous FX animations** for skeuomorphic and modern looks.
- **Texture library with blend modes** (Multiply, Screen, Overlay, Hue, Saturation, Color, Luminosity, etc.) for layering image assets over elements and backgrounds.
- **Global themes, font scale, and layer ordering.**
- **Editing tools:** undo/redo, select / multi-select, align / distribute, and snap-to-grid.

### AI Texture & Media Generation
- **Generate textures in-app** via Stable Diffusion (A1111/Forge and ComfyUI — launched and managed for you), DALL-E (`gpt-image-1`), Gemini Nano Banana, or OpenRouter.
- **Edit & enhance:** `editTexture` (img2img + inpainting), `upscaleTexture` (ESRGAN), `generateTextureVariations`, `batchGenerateTextures`, and `controlNetGenerate` (ControlNet).
- **SD process management:** start and stop A1111/ComfyUI from inside the app; processes are auto-killed when the app closes.

### Persistence & Export
- **Server-side persistence:** all data lives in `./data/` (sessions, textures, generated media, config, logs) as real files on disk. IndexedDB is used as a secondary fallback.
- **Export formats:** React/TSX components, JSON canvas data, or a ZIP package (`project.json` + assets + README) for integration into JUCE (via WebView) or web-audio projects.

## ⚡ Quick Start

### The easy way: `launch.bat`

Double-click **`launch.bat`** (Windows). It will:
- Install dependencies if needed
- Detect and repair broken native binaries
- Check for the Claude Code CLI
- Start the server and open your browser

### The manual way

```bash
npm install
npm run dev
```

The app will be available at `http://localhost:3000`.

### Prerequisites
- **Node.js 18+**
- **(Optional) Claude Code CLI** — only if you want to use the Claude Code provider:
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

## 🔑 API Keys

Add per-provider keys in **Settings**, or set them server-side in `.env` as a fallback. Cloud providers need a key; local providers do not.

| Provider | Key needed? | Where to get a key |
|---|---|---|
| Google Gemini | Yes | https://aistudio.google.com/apikey |
| OpenAI | Yes | https://platform.openai.com/api-keys |
| Anthropic | Yes | https://console.anthropic.com/settings/keys |
| xAI Grok | Yes | https://console.x.ai |
| Groq | Yes | https://console.groq.com/keys |
| OpenRouter | Yes | https://openrouter.ai/keys |
| OpenRouter Free | Yes | https://openrouter.ai/keys |
| Ollama (local) | **No** | https://ollama.com — runs locally |
| LM Studio (local) | **No** | https://lmstudio.ai — runs locally |

## 🤖 Claude Code Provider & MCP Relay

VST UI Foundry can use a locally installed **Claude Code CLI** as an AI provider. When selected, the app spawns the `claude` CLI as a subprocess with `--mcp-config` pointing at a bundled stdio MCP server (`mcp-server.cjs`).

A relay bridge connects the model to your live canvas:

```
Claude Code tool call → Express SSE → browser canvas executes → result POSTed back
```

This lets the model use the same 37 tools the in-app assistant uses — adding elements, restyling, generating textures, and more — while you watch the canvas update in real time. Requires the [Claude Code CLI](#prerequisites) to be installed.

## 🎨 Stable Diffusion Setup (Optional)

Local texture generation runs against your own Stable Diffusion install — VST UI Foundry launches and manages the process for you. This is entirely optional; cloud generation and the rest of the app work without it.

1. **Point the app at your install.** In **Settings**, set the path to your Stable Diffusion backend (A1111/Forge or ComfyUI). The app launches it headlessly when you generate; you do not need to start SD manually.
2. **Stability Matrix users:** point to the package's `launch.py` (A1111/Forge) or `main.py` (ComfyUI). The matching venv Python is auto-detected per package.
3. **Your paths stay private.** Personal paths and settings are written to `data/config.json`, which is gitignored and never committed.

## 🛠️ Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS 4, Vite 6, Monaco editor, motion, idb-keyval
- **Backend:** Express 5
- **Packaging / IO:** jszip, file-saver
- **AI:** 9 providers + Claude Code CLI over a stdio MCP server and SSE relay bridge

## 📚 Documentation

Extensive documentation lives in the [`/docs`](./docs/index.md) directory.

- [Getting Started](./docs/getting-started.md)
- [UI Components](./docs/ui-components.md)
- [Styling and Themes](./docs/styling-and-themes.md)
- [Exporting & Integration](./docs/exporting.md)
- [Project Management](./docs/project-management.md)
- [AI Assistant Orchestrator](./docs/ai-assistant.md)
- [AI Texture Generation](./docs/texture-generation.md)
- [Local Data & Persistence](./docs/local-data.md)

## 📜 License

MIT License. Created by StarskreamEXE.
