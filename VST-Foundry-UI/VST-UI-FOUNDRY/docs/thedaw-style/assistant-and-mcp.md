# Foundry Assistant — Orb, Providers, and MCP

Reference for Foundry's in-app AI co-designer: the floating **Assistant orb**,
the multi-provider chat backend, the persistent **Better Claude Code** (BCC)
session, and the **MCP** bridge that lets the model read and mutate your canvas.
Plain descriptions of what each piece does and how a message becomes a canvas
change. For the workspace it drives, see
[canvas-and-controls.md](canvas-and-controls.md); for the images it can
generate, see [textures-and-skins.md](textures-and-skins.md).

The assistant is optional — the rest of Foundry works without ever opening it —
but when open it has direct control of the layout: it can add, move, style,
align, group, theme, and delete elements, read hand-drawn annotations, fetch a
web page, generate textures, and screenshot the live window to check its own
work visually.

## How the pieces fit together

There are four moving parts, all on one machine:

1. **The orb (browser).** A React overlay that owns the chat UI and the canvas
   state. It POSTs each turn to the relay and executes tool calls locally.
2. **The relay server (Node/Express).** Serves the SPA, holds the provider
   catalog, streams chat over SSE, and bridges MCP tool calls to the browser.
3. **A provider.** Either a direct cloud/local API (Gemini, OpenAI, …) or the
   local **Claude Code CLI** spawned as a child process.
4. **The MCP server (`mcp-server.cjs`).** Only for the Claude path — a stdio
   JSON-RPC subprocess the CLI talks to, which relays tool calls back into the
   relay server and out to the browser.

| File | Role |
|---|---|
| `server.ts` | Relay entry: builds the Express app, adds Vite/static middleware, binds `127.0.0.1:PORT`, wires graceful shutdown. |
| `server/config.ts` | `PORT` resolution and the CORS origin allow-list helpers. |
| `server/routes.ts` | All HTTP routes: chat, transcribe, MCP relay, providers, models, textures, SD, config, state, logs, screen capture. |
| `server/relay.ts` | `activeSessions` registry + relay timeouts — the MCP-to-browser tool bridge state. |
| `server/providers.ts` | The `PROVIDERS` catalog plus the OpenAI-compat and Anthropic streamers and their agentic tool loop. |
| `server/tools.ts` | Tool schemas + system-instruction builder for the direct-API (non-Claude) path. |
| `server/claude-bridge.ts` | Claude Code CLI spawn, persistent per-conversation sessions, per-session MCP config writer. |
| `server/net.ts` | SSRF guards (`isPrivateIp` / `assertPublicUrl`) and the `scrapeUrl` reader for `fetchWebPage`. |
| `mcp-server.cjs` | Stdio JSON-RPC MCP server (~45 tools) the Claude CLI spawns; relays into Express. |
| `stt/transcribe.py` | Local speech-to-text via faster-whisper (CUDA float16 → CPU int8 fallback). |
| `src/components/AIAssistantOrb.tsx` | Top-level orb container: composes the chat/tool/speech hooks, settings, history, and the skin. |
| `src/components/orb/` | The orb's hooks and views (see [The orb UI](#the-orb-ui)). |
| `src/orb-kit-skin/GantasmoOrb.tsx` | The floating ghost-face orb button (visual skin only; owns its own drag position). |

## The relay server

Everything the assistant needs is served from one Node process, the same
sidecar that hosts the rest of Foundry (see
[foundry-overview.md](foundry-overview.md)).

- **Port:** `THEDAW_FOUNDRY_PORT` → `PORT` → `5472` (default), resolved in
  `server/config.ts`.
- **Bind:** `127.0.0.1` only (`server.ts`) — never exposed off the machine.
- **Dev vs prod:** in development Vite runs in **middleware mode on the same
  port**; HMR is disabled entirely when embedded in theDAW (`DISABLE_HMR=true`)
  and otherwise runs on `PORT+1`. In production the built `dist/` is served
  statically with an `index.html` catch-all.
- **No request/response timeout:** `httpServer.requestTimeout` and `.timeout`
  are set to `0` so a long agentic turn (many minutes of tool calls) is never
  aborted mid-stream.

> **CORS is locked to same-origin.** `/api/assistant` and `/api` reject any
> browser `Origin` that is not this app's own (`server/config.ts`). Requests
> with **no** `Origin` header — the MCP relay and other server-to-server calls —
> are allowed, since they are never a cross-site browser attack. Add extra
> origins with `FOUNDRY_ALLOWED_ORIGINS` (comma-separated) if needed.

### HTTP endpoints

| Method + path | Purpose |
|---|---|
| `GET /api/health` | Liveness probe (`{app, status, time}`). |
| `GET /api/assistant/providers` | Provider catalog. Claude/BCC is unshifted to the front. |
| `GET /api/assistant/models/:provider` | Model discovery for one provider (live fetch or fallbacks). |
| `POST /api/assistant/chat` | The one chat endpoint. SSE. Dispatches by `provider`. |
| `POST /api/assistant/transcribe` | Raw audio (`audio/*`) → faster-whisper → `{ok, text}`. |
| `POST /api/assistant/session/close` | Dispose a persistent Claude session (orb "new chat" / delete). |
| `POST /api/assistant/control-response` | Answer a live CLI question/permission (writes to the child's stdin). |
| `POST /api/assistant/control-request` | UI-initiated CLI control (e.g. `get_context_usage`). |
| `POST /api/mcp-relay/call` | Called by `mcp-server.cjs`: run a server-side tool, or relay a browser tool over SSE and block for its result. |
| `POST /api/mcp-relay/result` | Called by the browser: resolve a pending relayed tool call. |
| `POST /api/screen-capture` | Windows-only OS screenshot of the live theDAW window (PrintWindow). |
| `GET/POST /api/config` | Load/save app config (`data/config.json`). |
| `GET/POST /api/state` | Load/save the canvas session (`data/sessions/latest.json`, atomic + `.bak`). |
| `POST /api/textures/generate`, `/api/textures/upload`, `DELETE /api/textures/:id`, `GET /api/textures/list` | Texture library operations (see [textures-and-skins.md](textures-and-skins.md)). |
| `GET /api/sd/status`, `POST /api/sd/start`, `/api/sd/stop`, `GET /api/sd/resources` | Local Stable Diffusion process control. |
| `GET /api/logs` | Recent server log lines (ring buffer + disk tail). |

## Providers and models

The assistant is **bring-your-own-key** for cloud providers and needs no key for
local ones. The catalog is defined in `PROVIDERS` (`server/providers.ts`); the
Claude Code provider is deliberately **not** in that map and is special-cased in
the routes.

| Provider id | Label | Key required | Local | Notes |
|---|---|---|---|---|
| `claude` | BCC (Better Claude Code) | No | Yes | Spawns the local `claude` CLI. Surfaced FIRST in the providers list. |
| `gemini` | Google Gemini | Yes | No | OpenAI-compat base; models via Google's `/v1beta/models`. |
| `openai` | OpenAI | Yes | No | OpenAI-compat. |
| `anthropic` | Anthropic | Yes | No | Native Anthropic Messages API path. |
| `grok` | xAI Grok | Yes | No | OpenAI-compat. |
| `groq` | Groq | Yes | No | OpenAI-compat (no image input). |
| `openrouter` | OpenRouter | Yes | No | OpenAI-compat; capabilities parsed per model. |
| `openrouter-free` | OpenRouter (Free) | No | No | Same catalog filtered to zero-cost models. |
| `ollama` | Ollama (Local) | No | Yes | `http://localhost:11434`; models via `/api/tags`. |
| `lmstudio` | LM Studio (Local) | No | Yes | `http://localhost:1234`; OpenAI-compat `/v1/models`. |

> **Do not prune model ids you do not recognize.** `server/providers.ts` and
> `server/claude-bridge.ts` both carry a hard rule: the live `/models` fetch is
> the source of truth and the hard-coded fallbacks are safety nets only. Cloud
> keys reach the latest releases; a model that looks unfamiliar is almost always
> newer than training data, not invalid.

Cloud keys are entered per-provider in the orb's **Settings → Keys** tab and
stored in the browser's `localStorage`; they are sent with each chat request.
If no key is provided, the server falls back to the provider's environment
variable (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`XAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`). Model lists are discovered
at runtime, so the dropdown stays current without an app update.

### The three streaming paths

`POST /api/assistant/chat` is a single SSE endpoint that branches on `provider`:

| Path | Providers | Streamer |
|---|---|---|
| Claude CLI | `claude` | `streamClaude` (`server/claude-bridge.ts`) |
| Anthropic Messages | `anthropic` | `streamAnthropic` (`server/providers.ts`) |
| OpenAI-compatible | everything else in `PROVIDERS` | `streamOpenAICompat` (`server/providers.ts`) |

The `claude` branch owns its own SSE lifecycle and returns **before** the shared
setup below. The other two share one path: the route opens the SSE stream,
registers a relay session in `activeSessions`, and emits a `session_id` frame so
the browser knows where to POST tool results.

Both direct-API streamers run the **same agentic loop**: call the model, execute
any tool calls it emits, feed the results back, and repeat until the model
returns a tool-free answer — capped at `MAX_AGENT_ITERATIONS = 100` (a runaway
guard, not a functional limit). Server-side tools (texture/SD/`fetchWebPage`/
`getLogs`) run inside the relay process; every other tool is emitted as a
`client_tool_call` frame and the loop blocks on the browser's result via the
relay's pending-promise map. The direct-API tool schemas live in
`server/tools.ts` (the same canvas tools as MCP, plus `getLogs`); image-input
and tool-capability errors are detected and the turn retried with those features
stripped, so a text-only model still answers instead of erroring.

## Better Claude Code (the `claude` provider)

The primary and default provider spawns the local **Claude Code CLI** rather
than calling an HTTP API. It is invoked and managed by `server/claude-bridge.ts`,
which mirrors the proven Better Claude Code mechanism (the reference
implementation now lives under `deprecated/BETTERCLAUDECODE/`).

- **CLI discovery:** `findClaudeCmd()` honors `CLAUDE_CMD` (env override), else
  looks for `%APPDATA%\npm\claude.cmd` on Windows, else `claude.cmd` / `claude`.
- **Spawn shape:** on Windows the `.cmd` shim is run via `cmd.exe /c CLAUDE_CMD …`;
  elsewhere the binary is invoked directly. `NO_COLOR=1` is set.
- **Base args** (exact set and order):

```
--model <id> --dangerously-skip-permissions --permission-prompt-tool stdio
-p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages [--effort <effort>]
[--resume <session_id>] [--mcp-config <path> --strict-mcp-config]
```

> **There is no `--max-turns` flag.** The installed CLI (v2.1.195) does not have
> one; it runs each agentic turn to completion on its own. Do not reintroduce a
> turn cap — a complex layout task takes as many tool steps as it needs.

### Persistent per-conversation sessions

Instead of respawning the CLI every message, one long-lived `claude` child is
kept **per conversation** and reused across turns over stream-json stdio (the
child's stdin is never closed between turns). This is what keeps the MCP server
attached for the whole conversation instead of flapping every message.

| Constant | Value | Meaning |
|---|---|---|
| `MAX_CLAUDE_SESSIONS` | 8 | Live persistent children; LRU-reaped above this (never a busy one). |
| `CLAUDE_SESSION_IDLE_MS` | 15 min | Idle session reaped by the background reaper. |
| `CLAUDE_HEARTBEAT_MS` | 15 s | SSE keepalive comment cadence during a turn. |
| `CLAUDE_TURN_STALL_MS` | 5 min | Inactivity watchdog — re-armed on every stdout frame; only a true stall trips it. |

Each turn is serialized: a message that arrives while a turn is running is
**queued, not rejected** (BCC parity — mid-turn sends never return 409). The
route parks in the session's FIFO idle-waiter list, keeps the SSE alive with
pings, and resumes in arrival order when the in-flight turn finishes. Switching
model or effort on a live conversation respawns the child in place (resume keeps
context). Sessions are torn down on the orb's "new chat"/delete
(`/api/assistant/session/close`), on idle reap, on child death, and on server
shutdown; each disposal unlinks the temp MCP config and drops all relay
registrations.

### Model catalog and effort

Model ids are enumerated in `CLAUDE_MODELS` and passed **exactly** to `--model`
(the CLI's short aliases like `opus`/`sonnet` are unreliable on this machine).
`resolveClaudeModel()` maps any stale or family-alias value to the newest full
id in that family, so the CLI never receives a dead id. `CLAUDE_DEFAULT_MODEL`
is `claude-opus-4-8`. The catalog includes the current families plus `[1m]`
1M-context variants the CLI binary accepts.

> Model ids in the catalog change as new releases ship. Read them from
> `CLAUDE_MODELS` in `server/claude-bridge.ts` (surfaced by
> `GET /api/assistant/models/claude`) rather than assuming — the list is the
> source of truth.

`--effort` accepts `low` / `medium` / `high` / `xhigh` / `max` (default `max`).
The orb exposes the effort dropdown only when the Claude provider is selected.

### Questions and permissions (control requests)

Mid-turn, the CLI can block on stdin asking the user something — an
`AskUserQuestion` (multiple choice) or a `can_use_tool` permission prompt. The
bridge forwards these to the live SSE as a `control_request` frame; the orb
renders a card, and the user's choice is POSTed to
`/api/assistant/control-response`, which writes a `control_response` back to the
**same** blocked child. The turn stays open the whole time. The reverse
direction — the UI asking the CLI something like `get_context_usage` — goes
through `/api/assistant/control-request`, which powers the orb's real
context-window meter.

## The MCP tool surface

`mcp-server.cjs` is a stdio JSON-RPC 2.0 MCP server that the Claude CLI spawns as
a subprocess. For each conversation, `writeClaudeMcpConfig()` writes a temp
config registering one MCP server named **`vst-foundry`**:

```
node mcp-server.cjs <PORT> <relayId>
```

It handles `initialize`, `tools/list` (returns the tool schemas), `ping`, and
`tools/call`. stdout is reserved for protocol traffic; all diagnostics go to
stderr, or the JSON-RPC stream corrupts.

The server exposes ~45 tools. They split into two dispatch paths:

- **Server-side tools** (`SERVER_SIDE_TOOLS`) call Express endpoints directly
  with a 5-minute timeout — no browser needed. These are the texture/SD tools.
  `fetchWebPage` is also handled server-side, short-circuited inside the
  `/api/mcp-relay/call` route via SSRF-guarded `scrapeUrl` (`server/net.ts`).
- **Browser-relayed tools** POST `/api/mcp-relay/call`; the relay pushes a
  `client_tool_call` frame down the live SSE, the browser runs it against the
  real canvas, and POSTs the result to `/api/mcp-relay/result`.

> The header comment in `mcp-server.cjs` says "34 canvas/app tools" — that count
> is stale; the shipped `TOOL_SCHEMAS` array is larger (roughly 45 including the
> texture/SD family). Trust the array, not the comment.

### Read tools (browser-relayed)

| Tool | Reads |
|---|---|
| `getElements` | UI elements (all, or filtered by ids). |
| `getCanvasState` | Dimensions, zoom, pan, grid, snap, preview, rulers, background. |
| `getElementTree` | Group nesting + full z-order (paint order); flags CustomCode nodes. |
| `getRenderedGeometry` | Each element's ACTUAL on-screen rect mapped back to canvas coords (catches drift/rotation/overflow). |
| `getCustomCode` | One CustomCode element's full source, params, fit mode, runtime diagnostics. |
| `getAnnotations` | Hand-drawn strokes/shapes/notes + the color legend (placement instructions). |
| `getAssets` | Imported image/media assets (delegated to `App.tsx`). |
| `getTextures` | Texture library (delegated to `App.tsx`). |
| `getCustomModules` | Saved reusable CustomCode modules (delegated to `App.tsx`). |
| `getBindingCapabilities` | Full binding/modulation map: theDAW + built-in VST targets, per-type rules, current routes. |
| `captureCanvasScreenshot` | True PNG of the live window (see [Screenshots and vision](#screenshots-and-vision)). |

### Write / canvas tools (browser-relayed)

| Group | Tools |
|---|---|
| Element CRUD | `addElements`, `updateElements`, `setCustomCode`, `deleteElements`, `duplicateElements` |
| Layers | `reorderElement`, `reorderElementTo` |
| Grouping | `groupElements`, `ungroupElements` |
| Selection | `setSelection` |
| Alignment | `alignElements`, `distributeElements` |
| Canvas | `updateCanvas`, `setCanvasBackground` |
| History | `undo`, `redo` |
| App | `setTheme`, `setFontScale`, `addCustomModule` |

`setCustomCode` is the atomic way to edit a CustomCode element — it replaces the
source (and optionally params) and re-syncs the saved library module so the two
never drift. See [custom-code.md](custom-code.md).

### Texture / Stable Diffusion tools (server-side)

`generateTexture`, `applyTexture`, `removeTexture`, `deleteTexture`,
`uploadTexture`, `editTexture`, `upscaleTexture`, `generateTextureVariations`,
`batchGenerateTextures`, `controlNetGenerate`, `getSDStatus`, `getSDResources`,
`startSDProcess`, `stopSDProcess`. (`applyTexture`/`removeTexture` are
browser-relayed because they set element props; the rest hit Express directly.)
These are covered in [textures-and-skins.md](textures-and-skins.md).

### External

`fetchWebPage` — scrapes a URL server-side and returns its text. Guarded by
`assertPublicUrl` in `server/net.ts`, which rejects non-http(s) schemes,
`localhost`, and any host resolving to loopback, private, link-local (including
the `169.254.169.254` cloud-metadata address), or CGNAT ranges.

### Relay timeouts

| Constant | Where | Value | Role |
|---|---|---|---|
| `RELAY_TIMEOUT_MS` | `server/relay.ts`, `mcp-server.cjs` | 120 s | How long a single browser tool round-trip may take. |
| `RELAY_SERVER_TIMEOUT_MS` | `server/relay.ts` | 115 s | Server-side waiter — fires just BEFORE the client so it never writes to a destroyed socket. |
| `SERVER_SIDE_TIMEOUT_MS` | `mcp-server.cjs` | 300 s | Direct server-side tool calls (SD generation is slow). |

## How the assistant manipulates the canvas

The browser owns the canvas state, so every mutation ultimately runs in the
browser. The full round-trip for a Claude-driven canvas tool:

1. The CLI decides to call, say, `addElements`, and sends `tools/call` to
   `mcp-server.cjs` over stdio.
2. `mcp-server.cjs` POSTs `/api/mcp-relay/call` with the session id, tool name,
   and args.
3. The relay finds the live SSE session, registers a pending promise, and writes
   a `client_tool_call` frame down the SSE to the browser.
4. `useChatStream` receives the frame and hands it to `useToolActions`, which
   executes the tool against the orb's **live** element/canvas refs.
5. `useToolActions` POSTs `/api/mcp-relay/result`; the relay resolves the pending
   promise and responds to `mcp-server.cjs`, which returns the result to the CLI.

For the direct-API providers the shape is the same, minus `mcp-server.cjs`: the
streamer emits `client_tool_call` directly and awaits `/api/mcp-relay/result`.

> **Tools resolve against live state, not a mount-time snapshot.** Tool handlers
> can run from an SSE closure captured when the orb mounted, so `useToolActions`
> reads `elementsRef.current` / `canvasStateRef.current` (refreshed every render)
> instead of the frozen props. This is the fix for the old bug where
> `getElements` returned `[]` while elements were plainly on the canvas.

A handful of tools (`getAssets`, `getTextures`, `getCustomModules`, and the
layer/group/selection/align/theme mutations) live in `App.tsx`, not the orb.
`useToolActions` delegates those via a window `vst-ai-action` event; read tools
wait for a matching `vst-ai-action-result` event, mutations resolve
optimistically.

## The orb UI

`AIAssistantOrb.tsx` is the container. It composes three behavior hooks and the
transcript view, all handed the same live state and refs so behavior matches the
former single-file implementation.

| File | Role |
|---|---|
| `orb/useChatStream.ts` | POSTs `/api/assistant/chat`, reads the SSE loop, updates thinking/text/tool state, drains the mid-turn send queue. |
| `orb/useToolActions.ts` | Executes `client_tool_call` frames and POSTs results to `/api/mcp-relay/result`. |
| `orb/useSpeechInput.ts` | Mic capture → `/api/assistant/transcribe` (see [Voice input](#voice-input)). |
| `orb/providers.ts` | Normalizes backend provider/model records for the dropdowns. |
| `orb/Transcript.tsx` | Renders the transcript, tool cards, and question/permission prompts. |
| `orb/constants.ts` | LocalStorage keys, effort options, defaults (`claude` / `claude-opus-4-8`). |
| `orb/types.ts`, `orb/markdown.ts`, `orb/elements.ts` | Shared types, the inline-markdown link renderer, element normalization/coercion. |

Behavior worth knowing:

- **Mid-turn queue (BCC parity).** Typing while a turn streams does not fire a
  second colliding request. The message is parked in a FIFO queue (shown in the
  UI) and sent automatically when the current turn ends. **Stop** clears the
  queue and, if the agent is blocked on a question, denies it so the child
  returns to idle.
- **Per-turn accounting.** The `done` frame carries token usage (including
  cache), cumulative cost (the orb shows each turn's delta), duration, and error
  state. The context meter prefers the CLI's real `get_context_usage` reading
  and falls back to a character-count estimate for other providers.
- **Sessions.** Chats persist to `localStorage` (heavy base64 images stripped to
  stay under quota). Each app launch starts a fresh chat; prior chats remain as
  history. Abandoning or deleting a chat releases its backend Claude session.
- **The orb button** is `GantasmoOrb` (`src/orb-kit-skin/`) — a draggable
  ghost-face skin that only renders visuals and remembers its own position; the
  panel state lives in `AIAssistantOrb`.

## Voice input

The mic button dictates into the chat input (it appends transcribed text; it
does not auto-send). It appears only when the browser supports `getUserMedia`.

1. `useSpeechInput` records the mic with `MediaRecorder` (prefers `audio/webm`)
   and, on stop, POSTs the raw audio blob to `/api/assistant/transcribe`.
2. The route accepts an `express.raw` `audio/*` body (25 MB cap), writes a temp
   file under `os.tmpdir()/vst-foundry-stt`, and runs `stt/transcribe.py`
   (120 s timeout), returning `{ ok, text }`.
3. `transcribe.py` uses faster-whisper — CUDA `float16` first, CPU `int8`
   fallback — default model `small`. The model auto-downloads and caches on
   first use. Only the transcript goes to stdout; diagnostics go to stderr.

| Setting | Resolution |
|---|---|
| Python interpreter | `THEDAW_PYTHON_CMD` → `PYTHON_CMD` → `py -3.10` (Windows) / `python3` (else). |
| Whisper model | `small` (arg-overridable in the script). |
| Device | CUDA `float16`, falling back to CPU `int8`. |

> On Windows the `py -3.10` launcher is used because faster-whisper is installed
> under Python 3.10 there. If transcription fails, the failure detail is logged
> and returned as `{ ok:false, error }` — the orb surfaces it inline in the
> input box rather than silently dropping the recording.

## Screenshots and vision

The assistant can see the canvas two ways:

- **`captureCanvasScreenshot` (MCP tool) / `POST /api/screen-capture`** — a true
  OS capture of the live theDAW window via a DPI-aware PowerShell
  `PrintWindow` + `PW_RENDERFULLCONTENT` call. This is Windows-only and captures
  **real composited pixels including CustomCode** (sandboxed iframes) even when
  the window is occluded. If it is unavailable, the browser falls back to a
  synthetic redraw (`canvasMockup`) that cannot show CustomCode.
- **Attached images.** The camera/upload buttons and clipboard paste attach an
  image to the next message. For the Claude path the image is written to a temp
  file and referenced **by path** in the prompt (the CLI rejects inline base64
  blocks); the direct-API paths send it inline where the model advertises image
  input, and retry without it if the provider rejects it.

## Operational notes

- **The relay runs on port `5472`**, bound to localhost, started on demand when
  the Foundry tab opens. theDAW manages its start and stop; see
  [thedaw-integration.md](thedaw-integration.md).
- **The Claude path needs the `claude` CLI on PATH** (or `CLAUDE_CMD` set). If a
  turn errors immediately with a spawn failure, that is the first thing to check.
- **Local providers must be running.** Ollama (`:11434`) and LM Studio (`:1234`)
  return a clear "not running" error if their server is down; their tool calls
  are off unless `THEDAW_ENABLE_LOCAL_OPENAI_TOOLS=1`, because tool support
  varies by local model.
- **Temp files** land under `os.tmpdir()`: per-session MCP configs
  (`vst-mcp-<relayId>.json`), STT recordings (`vst-foundry-stt/`), and pasted
  images (`vst-foundry-pastes/`). Sessions unlink their own MCP config on
  teardown; a hard process exit cleans them synchronously.
- **When something breaks**, `GET /api/logs` returns recent server lines and the
  Claude bridge logs every turn, spawn, interrupt, and stale-result drain. See
  [troubleshooting.md](troubleshooting.md).

> **Note:** Foundry source is under active development. This document describes
> the assistant as it currently ships; if a detail here disagrees with the code,
> the code is authoritative — read the file named in each section.
