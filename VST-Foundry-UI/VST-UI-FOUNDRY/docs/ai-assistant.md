# AI Assistant

VST Foundry includes a built-in AI assistant that can see your canvas and build on it for you. Instead of placing every knob, slider, and meter by hand, you can describe what you want in plain language and the assistant does the work directly on the canvas.

This guide covers how to open it, which AI providers you can use, and everything the assistant can do.

---

## Overview

The assistant lives in a **glowing orb** that floats in the lower-right corner of the canvas. Click it to open the chat panel. From there you can:

- Ask for new controls ("add three knobs in a row at the top").
- Restyle what is already there ("make every slider neon cyan with a center glow").
- Reorganize a layout ("align these buttons and space them evenly").
- Generate textures and images and apply them to elements.
- Ask questions about your project or about audio UI design in general.

The assistant is **canvas-aware**. It can read your current elements, selection, theme, and assets, and it acts on them through real tools rather than just describing what to do. When you ask it to align three dials, it aligns them.

Responses stream in live. You will see the model's reasoning, status updates, and the final result as they happen, and you can stop generation at any time with the interrupt button.

---

## Providers

The assistant supports ten AI backends. Pick one from the provider selector at the top of the chat panel. Each provider stores its own API key locally in your browser, so you can switch freely without re-entering keys.

| Provider | What it is | Default model | API key |
|----------|-----------|---------------|---------|
| **Claude Code** | Anthropic's Claude running through the local Claude Code CLI. This is the default. | `claude-opus-4-6` | Uses your installed Claude Code CLI login (no key pasted here) |
| **Google Gemini** | Gemini via Google's OpenAI-compatible API | `gemini-2.5-flash` | [aistudio.google.com](https://aistudio.google.com) |
| **OpenAI** | GPT models | `gpt-4.1-mini` | [platform.openai.com](https://platform.openai.com) |
| **Anthropic** | Claude via Anthropic's direct Messages API | `claude-sonnet-4-6` | [console.anthropic.com](https://console.anthropic.com) |
| **xAI Grok** | Grok models | `grok-3-mini-fast` | [console.x.ai](https://console.x.ai) |
| **Groq** | Very fast open models on Groq hardware | `llama-3.3-70b-versatile` | [console.groq.com](https://console.groq.com) |
| **OpenRouter** | One key, hundreds of models | `google/gemma-3-1b-it` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenRouter (Free)** | Only OpenRouter's free models | live-fetched free models | Same OpenRouter key (no cost) |
| **Ollama (Local)** | Models running on your own machine via Ollama | your installed models | None — runs at `localhost:11434` |
| **LM Studio (Local)** | Models running locally via LM Studio | your loaded model | None — runs at `localhost:1234` |

**No key needed for local providers.** Ollama and LM Studio run entirely on your computer. Start either app, load a model, and the assistant will discover it automatically. Nothing leaves your machine.

**Where keys are stored.** API keys you enter are saved in your browser's local storage and sent only when needed to talk to that provider. They are never written to the server's environment.

---

## Claude Code (the default)

The default provider, **Claude Code**, is different from the others. Instead of calling a web API, it runs the **Claude Code CLI** as a local process on your machine. That gives Claude a richer, more capable agent loop and direct access to every canvas tool.

To use it you need the Claude Code CLI installed and logged in. If it is not installed, see Troubleshooting below.

### Effort

Claude Code has an **effort** selector that controls how much thinking it puts into a task:

- **low** — fastest, for simple changes.
- **medium** — balanced.
- **high** — more careful reasoning.
- **xhigh** — deep reasoning for tricky layouts.
- **max** — maximum effort (the default), best for complex, multi-step canvas work.

Higher effort takes longer but handles complicated requests more reliably.

### Mode

You can run Claude in **normal** mode or **extended thinking** mode. Extended thinking shows more of Claude's step-by-step reasoning, which is useful when you want to follow how it is approaching a layout problem.

### Session continuity

Claude Code **remembers your conversation across turns**. Each turn continues the same session, so you can build incrementally:

> "Add a row of four knobs."
> "Now label them Attack, Decay, Sustain, Release."
> "Make the Sustain knob bigger than the others."

Behind the scenes the assistant keeps a session ID and passes it back to the CLI with `--resume`, which reattaches to the same conversation instead of starting fresh. Start a new chat whenever you want a clean slate.

---

## Model Selection

For every provider you can either pick a model from a list or type one in:

- **Live discovery** — for most providers the assistant fetches the current list of available models directly from the provider (or from your local Ollama / LM Studio install) so you always see what is actually available to you.
- **Manual entry** — if you know the exact model name you want and it is not in the list, type it in. The assistant will use it as-is.

Model lists update when you switch providers. Your conversation history is preserved when you switch, so you can hand the same thread from one model to another.

---

## What the AI Can Do

The assistant has 37 tools grouped into the categories below. You do not call these directly. You ask in plain language and the assistant picks the right tools.

**Reading your canvas**
- See every element and its properties, read the overall canvas state, list your image assets and textures, and take a screenshot of the canvas so it can visually check alignment and styling.

**Creating and editing elements**
- Add new elements (knobs, sliders, buttons, meters, labels, and more), update existing ones, delete them, duplicate them, and change their stacking order (bring forward, send back, or move to an exact position in the layer order).

**Layout and grouping**
- Group and ungroup elements, align them (left, center, top, and so on), and distribute them with even spacing.

**Selection and canvas settings**
- Change which elements are selected, adjust canvas settings, and set the canvas background.

**History and appearance**
- Undo and redo changes, switch the app theme, and change the UI font scale.

**Web access**
- Fetch a web page so it can reference documentation or design inspiration you point it to.

**Textures and Stable Diffusion control**
- Generate a texture from a prompt, apply a texture to an element, remove or delete textures, upload an image as a texture, check Stable Diffusion status, list available SD resources (models, samplers, LoRAs), and start or stop the local SD process.

**Advanced image generation and editing**
- Edit an existing texture (img2img and inpainting), upscale a texture with ESRGAN, generate variations of a texture, batch-generate many textures at once, and run ControlNet for structure-guided generation.

---

## CustomCode Elements

The assistant can write **CustomCode** elements: small custom components built from your own HTML, CSS, and JavaScript. These run in a **sandboxed iframe** on the canvas, so they get full JavaScript execution while staying isolated from the rest of the app. The app injects its theme CSS variables, so a custom component can match your current theme automatically.

This is the way to get controls or visuals that the built-in element types do not cover. Just describe what you want:

> "Create a custom component that draws an animated VU needle that bounces with a fake signal."
> "Build a custom XY pad that prints its coordinates as text."
> "Make a custom panel that shows the current time in a seven-segment style."

The assistant writes the code, places it as a CustomCode element, and you can keep refining it by asking for changes.

---

## Texture and Image Generation

The assistant can create image assets and drop them straight onto the canvas. Beyond basic text-to-image generation, it can:

- **Edit** a texture with img2img or inpainting.
- **Upscale** a texture with ESRGAN.
- **Generate variations** of an existing texture.
- **Batch-generate** several textures from different prompts in one go.
- **ControlNet** generation, using a reference image to guide structure (canny, depth, openpose, and more).

For the full picture of providers, Stable Diffusion setup, where files are saved, and all the generation options, see the dedicated guide: [Texture Generation](texture-generation.md).

---

## Tips

- **Complex canvas work, use Claude Code.** For multi-step builds, precise alignment, and CustomCode components, Claude Code at high or max effort is the strongest choice because of its richer agent loop and full tool access.
- **Quick styling and one-off tweaks, use Gemini or GPT.** For fast restyles, color changes, and simple additions, `gemini-2.5-flash` or `gpt-4.1-mini` are quick and inexpensive.
- **Privacy or offline, use Ollama or LM Studio.** When you do not want anything leaving your machine, run a local model. No key, no cloud.
- **Free experimentation, use OpenRouter (Free).** Use the free-models provider to try things without spending anything.
- **Be specific about position and size.** Coordinates ("at x=100"), counts ("three knobs"), and style words ("center glow, neon cyan") give the assistant exactly what it needs.
- **Build incrementally.** Especially with Claude Code, make one change, see it, then ask for the next. The session remembers what you already did.

---

## Troubleshooting

**Claude Code says the CLI is missing or fails to start.**
Claude Code runs the local Claude Code CLI. Make sure it is installed and that you are logged in. Open a terminal and confirm the `claude` command works. If it does not, install the CLI and sign in, then reopen the assistant. As a fallback you can switch to the **Anthropic** provider, which talks to Claude over the web API and only needs an API key.

**A provider returns an error or "not running."**
- For cloud providers, check that you entered a valid API key for that provider and that the key has credit or quota.
- For **Ollama** and **LM Studio**, confirm the app is actually running and has a model loaded. The assistant expects Ollama at `localhost:11434` and LM Studio at `localhost:1234`. If you see a "not running" message, start the app first.

**The assistant streams text but never changes the canvas.**
Canvas tools run through an MCP relay: the AI requests a tool, the request is relayed to your browser, the browser performs the action, and the result goes back to the AI. If actions are not landing, make sure the app tab stays focused and open while the assistant works, and that you have not navigated away mid-generation. Try the request again. If a tool call seems stuck, use the stop button and re-ask.

**Local model has no models listed.**
The assistant discovers local models from the running app. If the list is empty, load a model in Ollama or LM Studio first, then reopen the provider selector to refresh.
