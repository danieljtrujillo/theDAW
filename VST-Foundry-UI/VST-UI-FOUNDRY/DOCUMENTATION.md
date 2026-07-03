# VST Foundry Documentation

This document is the architecture reference for VST Foundry. It is written for both human developers and any AI assistant working inside this codebase, and is injected into the AI assistant's context. It describes how the application is wired: state management, layout, element types, the multi-provider AI system, the tool surface, persistence, export, and the texture/generation pipeline. Be precise; the AI reads this as ground truth.

---

## 1. Project Overview

VST Foundry is a browser-based visual UI builder for synthesizer plugins, audio tools, and dense "watchmaker-level" interfaces. Users drag skeuomorphic controls (knobs, sliders, meters, and more) onto an infinite canvas, style them with a procedural glow/FX engine, and export the result as React/TSX, JSON, or a ZIP package.

### Tech stack
- **Frontend:** React 19 SPA built with Vite, TypeScript, functional components and hooks. No Redux; state is lifted into `App.tsx`. Styling via Tailwind CSS 4 and CSS variables. Framer Motion for animation. Monaco editor for the raw JSON property editor.
- **Backend:** A single Express server in `server.ts` (run via `tsx`). It serves the built SPA, proxies all AI provider traffic, manages the local Stable Diffusion process, performs texture generation, and persists project state to disk under `./data/`.
- **AI provider layer:** Lives in `server.ts`. Nine HTTP providers plus the local Claude Code CLI, fronted by three streaming functions and a Server-Sent Events (SSE) protocol.
- **MCP bridge:** `mcp-server.cjs` is a standalone stdio MCP server (JSON-RPC 2.0) that the Claude Code CLI loads per session. It exposes the canvas tool schemas to Claude and relays tool calls back to the browser over the live SSE channel.

### Server architecture (high level)
```
[Browser SPA] --HTTP/SSE--> [Express server.ts] --HTTP--> [Cloud AI providers]
      ^                            |
      |                            +--spawn--> [Claude Code CLI] --stdio--> [mcp-server.cjs]
      |                            |                                              |
      +----client_tool_call (SSE)--+<----------- POST /api/mcp-relay/call --------+
      +----POST /api/mcp-relay/result---------------------------------------------> (resolves Claude's tool call)
```

---

## 2. State Management

The app does not use an external state library. Core state is held in `App.tsx` with `useState` and a history hook, and passed down through props.

### Top-level state in `App.tsx`
- **`elements`** — the array of `UIElement` objects on the canvas. Wrapped by the `useHistory` hook (`src/hooks/useHistory.ts`) so every `setElements` call records an undo/redo frame. Z-order is the array order: later index renders on top.
- **`canvasState`** (`CanvasState`) — viewport and canvas configuration only: `{ backgroundImage, width, height, scale, panX, panY, showRulers }`. It holds the canvas frame, not the elements.
- **`selectedElementIds`** — array of selected element IDs.
- **`assets`** — uploaded image assets (`Asset[]`), base64 or object URLs, draggable onto the canvas.
- **`textures`** — generated/uploaded textures (`Texture[]`) applied to elements.
- **`clipboard`** — copied elements for paste.
- **`activeTool`** — `"select" | "pan"`.
- **`currentTheme`** — active theme id (e.g. `"default"`).
- **`fontScale`** — UI font scale multiplier.
- **`colorblindMode`** — accessibility toggle.
- **`savedProjects`** — list of `SavedProject` records loaded from IndexedDB.
- Modal flags and panel-open booleans (`isExportModalOpen`, `isRightPanelOpen`, `isCategoriesOpen`, etc.).

### What the AI sees as "app state"
When a request goes to the assistant, the client bundles a snapshot of `elements` + `canvasState` + `assets` + `textures`. The AI reads this through tools (`getElements`, `getCanvasState`, `getAssets`, `getTextures`) and mutates it through tools, never by editing arrays directly.

### History
`useHistory` keeps a past/future stack around the `elements` array. Any add, move, restyle, group, or delete pushes a new frame. `undo`/`redo` (both user-facing and AI tools) walk the stack.

---

## 3. Layout

`App.tsx` composes the UI into three horizontal regions plus floating surfaces.

- **`Sidebar.tsx` (left):** Component library. Collapsible categories of draggable elements, a split Categories/Explorer view, a Saved Presets category (from `localStorage`), and the `AssetManager` for uploading background/reference images. Drag-and-drop uses the HTML5 Drag & Drop API.
- **`Canvas.tsx` (center):** The infinite work area. Handles drops from the Sidebar, absolute positioning with CSS transforms for pan/zoom (Spacebar+drag to pan, scrollwheel to zoom), selection bounding boxes, and resize/drag handles.
- **`LayersPanel.tsx` + `CompactElementProperties.tsx` (right):**
  - **Layers** — manages z-order (array order), selection, visibility, and lock state.
  - **Properties** — `CompactElementProperties.tsx` for single selection (Geo/Data/Style/Image/Raw tabs, Raw being a Monaco JSON editor); multi-selection alignment (align, distribute, normalize size) is handled in `App.tsx`.
- **`AIAssistantOrb.tsx` (floating, lower-right):** The AI assistant. Provider selector with live model discovery, per-provider API key storage in `localStorage`, effort selector (Claude), Claude mode (normal/extended thinking), streaming reasoning/status/text, grounding links, image paste/upload, and canvas screenshot capture. Maintains `claudeSessionId` for session continuity and preserves conversation history across provider switches.
- **`TextureManager.tsx` / Texture Library (floating panel):** Lists textures, opens the generation modal (`TextureGenerateModal.tsx`), and applies textures to elements.

Left and right panels collapse via edge toggles to maximize canvas area.

---

## 4. Element Types

Rendering happens in `src/components/InteractiveControl.tsx`, which takes a `UIElement` plus an `isPreview` flag. Every element shares dimensional (`x, y, width, height`), aesthetic (`baseColor, activeColor, glow*, opacity, variant`), and data (`type, label, min, max, value`) properties, and each type adds its own.

- **`Knob`** — circular rotary control; drag up/down in preview to rotate.
- **`Slider`** — linear potentiometer, vertical or horizontal; bipolar, thin, brutalist, and standard variants.
- **`Button`** — momentary push button; highlights on `mousedown`.
- **`Toggle`** — persistent on/off switch (checkbox, brutalist block, neumorphic slider).
- **`Label`** — typography element.
- **`Select`** — dropdown menu.
- **`Waveform` / `Meter`** — visualizers (VU meters, oscilloscopes, LED strips).
- **`XYPad` / `Spatial3D`** — 2D coordinate selectors.
- **`Image`** — placed image asset; supports background removal (tolerance, target color, feathering), chroma keying, and layer blend modes (multiply, screen, overlay, hue, saturation, etc.). Glow uses contour-matched `filter: drop-shadow` for transparent PNGs.
- **`CustomCode`** — a custom component authored in HTML/CSS/JS. It renders as a **sandboxed iframe** (`<iframe srcdoc sandbox="allow-scripts">`), giving it full JavaScript execution while isolating it from the host app. Theme CSS variables are injected into the iframe document so custom components track the active theme. In design mode a pointer-event overlay sits over the iframe so it can be selected and moved without the iframe swallowing canvas interactions; in preview mode the overlay is removed so the component is fully interactive.

### Variants and the glow engine
Variants (Brutalist, Neumorphic, Classic, CellShaded, and more) change the DOM structure of an element, not just its colors. The procedural glow engine is controlled by `glowStyle` (`outer`/`inner`/`center`), `glowAmount`, `glowSpread`, `glowColor`, `glowOpacity`, and optional `glowGradient`. `glowActiveOnly` gates glow on the element's live interactive state. Continuous non-interactive FX include breathing, flickering, floating, and orbital glow loops.

---

## 5. The AI Provider System

All AI traffic flows through `server.ts`. There are nine HTTP-backed providers plus the local Claude Code CLI.

### The `PROVIDERS` dictionary
`PROVIDERS: Record<string, ProviderConfig>` defines the nine HTTP providers. Each entry has `label`, `baseUrl`, `envKey`, `modelsPath`, `defaultModel`, `requiresKey`, and `isLocal`.

| Key | Label | Base URL | Default model | Local | Key required |
|-----|-------|----------|---------------|-------|--------------|
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | no | yes |
| `openai` | OpenAI | `https://api.openai.com` | `gpt-4.1-mini` | no | yes |
| `anthropic` | Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-6` | no | yes |
| `grok` | xAI Grok | `https://api.x.ai` | `grok-3-mini-fast` | no | yes |
| `groq` | Groq | `https://api.groq.com/openai` | `llama-3.3-70b-versatile` | no | yes |
| `openrouter` | OpenRouter | `https://openrouter.ai/api` | `google/gemma-3-1b-it:free` | no | yes |
| `openrouter-free` | OpenRouter (Free) | `https://openrouter.ai/api` | `google/gemma-3-1b-it:free` | no | no |
| `ollama` | Ollama (Local) | `http://localhost:11434` | (discovered) | yes | no |
| `lmstudio` | LM Studio (Local) | `http://localhost:1234` | (discovered) | yes | no |

`openrouter-free` shares the OpenRouter key but filters the model list to free models (`pricing.prompt === "0"`), fetched live. Local providers (`ollama`, `lmstudio`) need no key and discover models from the running app (`/api/tags` for Ollama, `/v1/models` for LM Studio).

**`claude` is intentionally NOT in `PROVIDERS`.** It is special-cased in the chat route because it spawns a local CLI process rather than making an HTTP call. Claude Code constants in `server.ts`: `CLAUDE_DEFAULT_MODEL = "claude-opus-4-6"`, `CLAUDE_FALLBACK_MODEL = "claude-sonnet-4-6"`, `CLAUDE_DEFAULT_EFFORT = "max"`, `CLAUDE_VALID_EFFORTS = [low, medium, high, xhigh, max]`, `CLAUDE_MAX_TURNS = 25`, and a `CLAUDE_MODELS` catalog (Opus 4.6, Sonnet 4.6, Haiku 4.5).

### The three streamers
The chat route dispatches to one of three async-generator streamers, each yielding normalized `Frame` objects:

1. **`streamOpenAICompat`** — handles all nine HTTP providers via `fetch` against an OpenAI-compatible `/v1/chat/completions` SSE endpoint (Gemini uses Google's OpenAI-compat surface). Parses streamed deltas, tool calls, and grounding.
2. **`streamAnthropic`** — uses the Anthropic SDK directly against the streaming Messages API for the `anthropic` provider. Maps `text_delta` and `thinking_delta` content blocks to frames and surfaces tool-use blocks.
3. **`streamClaude`** — spawns the Claude Code CLI as a subprocess and communicates over NDJSON on stdin/stdout. This is the path used by the default `claude` provider.

### Claude Code spawn
`streamClaude` builds the CLI argument list:
```
claude --print --output-format stream-json --include-partial-messages \
       --input-format stream-json --verbose --max-turns 25 \
       --dangerously-skip-permissions --model <model> --effort <effort> \
       [--fallback-model <fallback>] \
       (--resume <sessionId> | --session-id <newUuid>) \
       --mcp-config <tmpdir>/vst-mcp-<sessionId>.json
```
- `--resume <sessionId>` is used when a UUID-like `claudeSessionId` is supplied (session continuity); otherwise a fresh `--session-id` UUID is generated.
- The user turn is written to stdin as a single stream-json NDJSON line (`{ type: "user", message: { role, content } }`), then stdin is closed so the CLI processes one turn and exits.
- `--fallback-model` is added when a fallback is resolvable (default `claude-sonnet-4-6`).
- The process runs with `cwd = PROJECT_CWD`. Abort signals kill the process.

### Per-session MCP config and the relay
Before spawning, `streamClaude` writes a per-session MCP config to the OS temp dir at `vst-mcp-<sessionId>.json`:
```json
{ "mcpServers": { "vst-foundry": { "command": "node",
  "args": ["<cwd>/mcp-server.cjs", "<PORT>", "<sessionId>"], "env": {} } } }
```
The CLI loads this with `--mcp-config`. `mcp-server.cjs` is a stdio JSON-RPC 2.0 MCP server that advertises the canvas tool schemas to Claude and bridges tool execution back to the browser.

**Session registry.** When the SSE response exists, the session is registered in `activeSessions: Map<sessionId, { sseRes, pending: Map }>`. This lets the relay endpoints locate the live SSE channel and resolve pending browser tool calls for that session.

**Relay flow (Claude tool call -> browser -> Claude):**
1. Claude invokes an MCP tool. `mcp-server.cjs` receives the JSON-RPC `tools/call`.
2. If the tool is in `SERVER_SIDE_TOOLS`, `mcp-server.cjs` calls the Express server directly (no browser involved) and returns the result to Claude.
3. Otherwise it POSTs `/api/mcp-relay/call` with `{ sessionId, toolCallId, toolName, args }`.
4. The server looks up the session, emits a `client_tool_call` frame `{ type, id, name, args }` over that session's live SSE channel, and blocks the relay request (up to ~30s).
5. The browser executes the tool against the live canvas and POSTs `/api/mcp-relay/result` with the result.
6. The server resolves the pending relay request; `mcp-server.cjs` returns the result to Claude, which continues its turn.

### SSE frame protocol
All streamers yield `Frame` objects (`{ type, ... }`) that the route serializes as SSE `data:` lines. Frame types:
- **`text_delta`** `{ text }` — incremental assistant text.
- **`thinking`** `{ text }` — incremental reasoning / extended-thinking text.
- **`status`** `{ message }` — human-readable progress (e.g. "Starting Claude Code...").
- **`session_id`** `{ sessionId }` — the Claude session id for this turn, used by the client to resume next turn.
- **`client_tool_call`** `{ id, name, args }` — a tool the browser must execute (relayed canvas tools).
- **`tool_result`** `{ id, result }` — the result of a server-executed tool.
- **`grounding`** — web-search grounding sources/URLs.
- **`done`** — stream complete.
- **`error`** `{ message }` — failure detail.

### AI HTTP endpoints
- `GET /api/health` — server liveness.
- `GET /api/assistant/providers` — provider catalog (includes the special `claude` entry and its default model).
- `GET /api/assistant/models/:provider` — live model discovery for a provider.
- `POST /api/assistant/chat` — the streaming chat endpoint (SSE). Accepts messages, provider, model, effort, claudeSessionId, mode, app state, and per-request API key.
- `POST /api/mcp-relay/call` — invoked by `mcp-server.cjs`; emits `client_tool_call` and blocks for the browser result.
- `POST /api/mcp-relay/result` — invoked by the browser to resolve a pending relayed tool call.

---

## 6. The 38 Tools

The tool schemas are defined in `mcp-server.cjs` (for the Claude/MCP path) and mirrored for the HTTP providers in `server.ts`. Tools are either **server-side** (executed directly by `mcp-server.cjs` against the Express server via the `SERVER_SIDE_TOOLS` map, no browser involvement) or **client relay** (executed in the browser through `/api/mcp-relay/*`).

### Canvas Read (5) — client relay
- `getElements` — return all elements and their properties.
- `getCanvasState` — return the canvas/viewport state.
- `getAssets` — list uploaded image assets.
- `getTextures` — list available textures.
- `captureCanvasScreenshot` — render the canvas to an image for vision.

### Element CRUD (6) — client relay
- `addElements` — create one or more elements.
- `updateElements` — patch properties on existing elements.
- `deleteElements` — remove elements by id.
- `duplicateElements` — clone elements.
- `reorderElement` — move an element relative in z-order (forward/back).
- `reorderElementTo` — move an element to an exact z-index position.

### Layout & Groups (4) — client relay
- `groupElements` — group selected elements.
- `ungroupElements` — dissolve a group.
- `alignElements` — align (left/right/top/bottom/center).
- `distributeElements` — distribute with even spacing.

### Selection & Canvas (3) — client relay
- `setSelection` — set the selected element ids.
- `updateCanvas` — modify canvas/viewport settings.
- `setCanvasBackground` — set the canvas background image/color.

### History & Theme (4) — client relay
- `undo` — undo the last change.
- `redo` — redo.
- `setTheme` — switch the active theme.
- `setFontScale` — set the UI font scale.

### External (1) — client relay
- `fetchWebPage` — fetch a URL for reference content.

### Texture Ops (9) — mixed
- `generateTexture` — text-to-image texture generation. **server-side** (`POST /api/textures/generate`).
- `applyTexture` — apply a texture to an element. **client relay**.
- `removeTexture` — remove a texture from an element. **client relay**.
- `deleteTexture` — delete a texture from the library. **server-side** (`DELETE /api/textures/:id`).
- `uploadTexture` — upload an image as a texture. **server-side** (`POST /api/textures/upload`).
- `getSDStatus` — Stable Diffusion process status. **server-side** (`GET /api/sd/status`).
- `getSDResources` — list SD models/samplers/LoRAs. **server-side** (`GET /api/sd/resources`).
- `startSDProcess` — start the local SD backend. **server-side** (`POST /api/sd/start`).
- `stopSDProcess` — stop the local SD backend. **server-side** (`POST /api/sd/stop`).

### Generation (6) — server-side
- `editTexture` — img2img / inpaint an existing texture (`POST /api/textures/edit`).
- `upscaleTexture` — ESRGAN upscale (`POST /api/textures/upscale`).
- `generateTextureVariations` — produce variations of a texture (`POST /api/textures/variations`).
- `batchGenerateTextures` — generate many textures from a list of prompts in one call (`POST /api/textures/batch`).
- `generateVideo` — generate a short video with Google Veo 3.1 (text-to-video or image-to-video, 4-8s, 720p/1080p/4K, native audio; `veo-3.1` / `veo-3.1-fast` / `veo-3.1-lite`). Returns a long-running operation id to poll for completion (`POST /api/videos/generate`).
- `controlNetGenerate` — structure-conditioned generation via ControlNet on A1111/ComfyUI (canny, depth, openpose, lineart, scribble, tile, and more; `POST /api/textures/controlnet`).

**Total: 38 tools** (5 + 6 + 4 + 3 + 4 + 1 + 9 + 6). Server-side tools are the 13 generation/SD/texture-management calls listed above (including `generateVideo`); the remaining 25 are executed in the browser through the relay.

---

## 7. Persistence

The server persists project state to disk under `./data/`. This is the primary store; IndexedDB is a secondary fallback in the browser.

### `./data/` structure
- `sessions/latest.json` — the autosaved project (elements, canvasState, assets, textures). Auto-saved roughly every 5 seconds and on change.
- `textures/` — uploaded and generated texture image files.
- `generated/` — generation output (images and other generated media).
- `config.json` — server-side configuration.
- `logs/` — server logs (`appendLog`).

### State endpoints
- `GET /api/state` — read the persisted project state. On load the client prefers server state over IndexedDB; if both exist, server wins.
- `POST /api/state` — write the project state (autosave target).
- `GET /api/config` / `POST /api/config` — read/write server config.
- `GET /api/health` — liveness probe.

### Browser-side fallback
The SPA uses `idb-keyval` (IndexedDB) for saved projects (`ui-modeler-projects`) and a local autosave (`ui-modeler-autosave`). Custom code and custom presets are stored in `localStorage`. If the server is unavailable, the app falls back to IndexedDB.

---

## 8. Export

Exporting is driven from `Header.tsx` and `ExportModal.tsx`:
- **Save/Load Project** — writes/reads the full project to IndexedDB.
- **Export to JSON** — serializes the current layout to a raw JSON object.
- **Export to React/TSX** — generates a functional React component (`.tsx`) using Tailwind CSS and inline styles that reproduces the layout.
- **Export Package (`.zip`)** — bundles `project.json`, background images, a split directory of per-element JSON files, and an auto-generated `README.md` into a downloadable ZIP using `jszip` and `file-saver`.

---

## 9. Texture and Generation System

Texture generation is exposed in the Texture Library (the **Gen** button opens `TextureGenerateModal.tsx`) and through the AI tools above. The server orchestrates providers and the local Stable Diffusion process.

### Image providers
- **Stable Diffusion (local)** — A1111/Forge/Neo (AUTOMATIC1111-compatible) and ComfyUI backends. Free, runs on the local GPU, supports custom models, LoRAs, samplers, ControlNet, and ESRGAN upscaling. Batch generation via the queue.
- **DALL-E (OpenAI cloud)** — text-to-image; needs an OpenAI key.
- **Gemini / Nano Banana (Google cloud)** — text-to-image and natural-language edits; needs a Gemini key.
- **Video** — Google Veo 3.1 (`generateVideo`), text-to-video and image-to-video.

### SD process management
The server can start and stop the local Stable Diffusion backend and query its status and resources, so the app manages the SD lifecycle directly rather than requiring a separately launched server.
- `GET /api/sd/status` — running state and backend type.
- `POST /api/sd/start` — start the chosen backend (`sdType`).
- `POST /api/sd/stop` — stop it.
- `GET /api/sd/resources?type=...` — enumerate models, samplers, LoRAs, etc.

### Generation endpoints
- `POST /api/textures/generate` — base text-to-image generation.
- `POST /api/textures/edit` — img2img / inpaint.
- `POST /api/textures/upscale` — ESRGAN upscale.
- `POST /api/textures/variations` — variations of an existing texture.
- `POST /api/textures/batch` — multi-prompt batch generation.
- `POST /api/textures/controlnet` — ControlNet structural conditioning (A1111/ComfyUI).
- `POST /api/videos/generate` — Veo 3.1 video generation (returns an operation id to poll).
- `POST /api/textures/upload`, `GET /api/textures/list`, `DELETE /api/textures/:id` — texture library management.

Generated images land in the Texture Library and on disk under `./data/textures/` and `./data/generated/`, ready to apply to elements like any uploaded asset. For the user-facing walkthrough see `docs/texture-generation.md`.

---

## Guidelines for AI Integration

When operating this application as an AI:
1. **Never mutate `elements` directly.** Use the tools; treat state as immutable and let the history hook record frames.
2. **Generate unique element IDs** for new elements.
3. **Z-order is array order.** To bring an element forward, move it later in the array (`reorderElement` / `reorderElementTo`).
4. **Use the app's CSS variables** (`var(--base-color)`, `var(--active-color)`) rather than hardcoded Tailwind colors, so elements stay theme-reactive.
5. **Respect default proportions:** sliders tall, buttons wide, knobs square.
6. **Prefer structured tool calls** over describing coordinates. When asked to align, distribute, restyle, or reorder, invoke the matching tool.
7. **CustomCode runs in a sandboxed iframe.** Custom components have full JS but are isolated; theme variables are injected, and a design-mode overlay handles selection.
