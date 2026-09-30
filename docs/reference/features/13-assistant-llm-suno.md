## AI Assistant, LLM Providers & Cloud Integrations

theDAW includes an in-app AI assistant (the "orb") plus several server-side integrations that let it reason about your project, control the app, and reach external music/LLM services. Every provider API key is held server-side; the browser never sees a real key.

### In-app Assistant (multi-provider chat)

The assistant streams responses over Server-Sent Events and can talk to a dozen providers:

- **Cloud LLMs**: Google Gemini, OpenAI, Anthropic, xAI Grok, Groq, and OpenRouter (plus an OpenRouter-Free variant).
- **Local LLMs (no key, no cloud)**: Ollama, LM Studio, llama.cpp, and vLLM at their default `localhost` ports.
- **Claude Code**: a special provider that runs the local Claude Code CLI as a full in-repo coding agent (with tools, MCP servers, and skills), not just a chat model.

Default models per provider are configured in the provider catalog (for example Gemini defaults to `gemini-flash-recent`, OpenAI to `gpt-4.1-mini`, Groq to `llama-3.3-70b-versatile`, OpenRouter to the free `google/gemma-3-1b-it:free`). Model lists are discovered live from each provider (with capability tags like tools / vision / reasoning / long_context) and fall back to built-in catalogs when the live fetch is unavailable.

*Evidence: `backend/assistant_routes.py:249`, `backend/assistant_routes.py:3089`, `backend/server.py:1986`.*

### Controlling the app by chat

Ask the assistant to do something ("switch to advanced", "set the prompt to epic orchestral and generate") and it drives the UI directly. Providers with native function calling receive an OpenAI-style tool schema (`theDAW_TOOLS`, converted to Anthropic tool format for Claude); other models emit `<action>{...}</action>` blocks the frontend executes. Actions cover navigation, prompt editing, every generation parameter, generate/abort/status, and a full **timeline-editing vocabulary**.

**Navigation reaches every workspace.** `navigateTo()` resolves all thirteen center tabs plus the library rail, and returns false — reported back to the model — on an unknown target, instead of silently no-opping while claiming success (`frontend/src/state/appUiStore.ts`).

**Editor tools.** The assistant has a full EDIT vocabulary — 58 `editor_*` tools plus the 5 `dj_*` performance tools — declared once in `backend/modules/assistant/tool_catalog.py` (the same catalog feeds the OpenAI/Gemini tool arrays and the `thedaw` MCP server). They cover notes on MIDI clips (`editor_quantize_clip` with grid/strength/swing, `get_notes`/`set_notes`, `nudge_notes` in steps/ms/ticks, `transpose_clip`, `scale_velocity`, `humanize_clip`, `fix_overlaps`, `filter_notes`, `set_clip_instrument`), tempo and time (`set_clip_source_bpm`, `stretch_clip` — MIDI re-renders locally, audio goes through the pitch-preserving `/api/editor-tools/stretch`, `detect_tempo`, `set_time_signature`, `nudge_clip`), transport (`play`, `stop`, `seek_bar`, `loop_selection`), clips (`set_clip`, `trim_clip`, `duplicate_clip`, `merge_clips`, `crossfade_clips`, `reverse_clip`, `normalize_clip`, `bounce_clip`), selection and grid (`select_clips`, `select_range`, `select_notes`, `set_snap`, `set_tool`), tracks (`set_track` incl. armed/instrument, `reorder_tracks`, `duplicate_track`), analysis (`analyze_clip` → onsets/tempo/key/RMS, `compare_timing` → MIDI-vs-audio offset, `get_waveform_peaks`), markers, automation lanes/points, and safety (`undo`, `redo`, `snapshot`, `restore`). Every tool runs through the `editorTools` facade (`frontend/src/state/editorTools.ts`) with honest error strings, records undo automatically, and re-renders a MIDI clip's audio before reporting success. The app context (`editorState`) marks every clip and track `kind: midi | audio` (plus `noteCount`, `instrumentProgram`, `sourceBpm`, snap, tool, markers, FX chains, time signature, selection, snapshots) — previously MIDI clips were indistinguishable from audio, so the assistant reported every track as audio. The alignment recipe the prompt teaches: `editor_detect_tempo` → `editor_set_clip_source_bpm` → `editor_compare_timing` → `editor_nudge_notes` → `editor_quantize_clip`.

**Approval tiers.** Tools are tiered: T0 read/navigation runs silently, T1 mutations run and show a receipt, and **T2 — anything that spends GPU, destroys work, or is hard to reverse** (`generate`, `abort`, `editor_remove_*`, `merge_clips`, `freeze_track`, `restore`, `reorder_tracks`, unknown names) — parks as a pending action card with Run/Skip. On the Claude Code provider the card appears *during* the turn (the model is waiting on the answer); Skip returns "User declined." to the model. Inline `<action>` blocks from non-function-calling models are allowlist-validated and tier-gated on the same path (`frontend/src/orb-kit/tool-tiers.ts`, `stream/frameReducer.ts`, `assistantEvents.ts`).

*Evidence: `backend/modules/assistant/tool_catalog.py`, `frontend/src/state/editorTools.ts`, `frontend/src/orb-kit/appContext.ts`, `frontend/src/orb-kit/tool-tiers.ts`.*

### Claude Code agent mode

Selecting the **Claude Code** provider holds **one persistent `claude` CLI child per conversation** (Better-Claude-Code parity, ported from the Foundry): spawned once with `--input-format stream-json`, stdin kept open, each message written as one NDJSON turn, interrupt without kill, a 5-minute inactivity watchdog, LRU/idle reaping (`backend/modules/assistant/claude_session.py`). Every live child (and its MCP relay child) is reaped when the backend shuts down, and the session lifecycle is logged to the backend console as `[claude_session] spawned / respawned / torn down` lines. The old per-message spawn (which booted every global MCP server on every turn) is retired to `backend/deprecated/`. The child boots **only** the `thedaw` MCP relay (`--strict-mcp-config`; plus the underfit trainer for that profile, plus an optional `THEDAW_ASSISTANT_EXTRA_MCP_CONFIG` file) — so on this provider every app action is a real MCP tool (`mcp__thedaw__editor_get_state`, …) whose result returns to the model in the same turn, via `/api/mcp-relay/call` → browser → `/api/mcp-relay/result`.

**Permission modes and bubbles.** A dropdown in the assistant header (Claude Code only) picks the mode: **Ask** (default — reads are free, edits/shell/agents/MCP prompt), **Accept edits** (in-repo edits run, shell/agents prompt), **Read-only** (everything but reads is denied), **Trusted** (no prompts). The CLI runs without `--dangerously-skip-permissions`; every `can_use_tool` request reaches the app (`--permission-prompt-tool stdio`), the policy in `backend/modules/assistant/permissions.py` decides allow/deny/ask, and an "ask" renders a permission card with Allow once / Allow for session / Deny. The user's global `~/.claude/settings.json` is deliberately not loaded (`--setting-sources project,local`) so the app's policy is authoritative. **Self-enhancement:** the agent may extend its own tool surface (`tool_catalog.py`, `actionHandlers.ts`, `tool-tiers.ts`, `appContext.ts`, `assistant_routes.py`); any edit to those files **always** prompts, in every mode except Read-only, with a SELF-MODIFY banner naming the file and a warning when a backend restart will follow.

**Transcript.** The chat renders tool rows (with diff cards for edits, nested cards for sub-agents, todo lists), permission and question cards, per-turn cost/tokens/duration, and collapsible reasoning; a turn that produced only tool activity shows no empty bubble, and status text is a single live line under the composer.

*Evidence: `backend/modules/assistant/{claude_session.py,permissions.py,mcp_relay.py,thedaw_mcp_server.py,tool_catalog.py}`, `backend/assistant_routes.py` (control-response / permission-mode / interrupt routes), `frontend/src/orb-kit/{stream,transcript,permission}/`, `orchestration/lint/liveproof-run5-lead.txt`.*

### Grounded answers with local RAG

Before answering, the assistant retrieves the top-5 most relevant chunks from a **ChromaDB** index built over theDAW's markdown docs. Docs are chunked by markdown headers (<= 800 chars) and embedded with **all-MiniLM-L6-v2** on CPU. The index initializes lazily on first use, skips re-indexing when docs are unchanged, and runs with `HF_HUB_OFFLINE=1` so retrieval never blocks on the network. Retrieved context is injected as system context for most models; Claude Code gets a compact version and can read files directly for more.

*Evidence: `backend/rag.py:21`, `backend/rag.py:207`, `backend/assistant_routes.py:3340`, `pyproject.toml:28`.*

### API key pool

Add multiple keys per provider and the pool round-robins across them with smart cooldowns: 60s on a generic failure, 5 min after 3 consecutive failures, a permanent (1-year) ban on 401/403, 8h on a daily-quota 429, and 2s on a plain rate-limit 429. Keys load from environment variables and `data/api_key_pools.json`; the Gemini streamer rotates to the next key automatically when it hits a 429 mid-request.

*Evidence: `backend/key_pool.py:79`, `backend/key_pool.py:209`, `backend/assistant_routes.py:1804`.*

### Suno song generation

The Suno module proxies the frontend to the Suno public API (`https://api.suno.com`, Berklee hackathon) while keeping `SUNO_API_KEY` server-side (env or `data/suno_api_key.json`). It supports simple / custom / cover / mashup generation, job polling, three preset voices, and account usage. Finished MP3s are downloaded and registered as **first-class library entries** (tagged `model: suno`); cover and mashup tracks record parent -> child lineage edges via a `sunoid:<clip_id>` tag so they appear in the genealogy graph. Downloads are guarded by an SSRF host allowlist.

*Evidence: `backend/modules/suno/router.py:58`, `backend/modules/suno/router.py:270`, `backend/modules/suno/router.py:51`.*

### Gemini native proxy (vocal2midi / AI compose)

A thin pass-through forwards any request to Google's Generative Language API (`https://generativelanguage.googleapis.com`), injecting the server-side `GEMINI_API_KEY` as `x-goog-api-key` and stripping any client key. The frontend's `@google/genai` SDK points its base URL at `/api/genai-proxy` with a placeholder key, so the vocal2midi suite (audio-to-MIDI cleanup and metadata) and the AI compose client call **gemini-3.5-flash** with no key ever in the browser. If `GEMINI_API_KEY` is unset the proxy returns 503.

*Evidence: `backend/modules/genaiproxy/router.py:29`, `frontend/src/components/audio/vocal2midi/geminiService.ts:60`, `frontend/package.json:22`.*

### Hugging Face auth

For downloading gated model weights, the HF auth module detects a token (from `HF_TOKEN` or huggingface_hub's standard token file), validates it against `whoami-v2` (non-blocking, cached 10 minutes on a daemon thread), and supports login/logout plus a link to mint a new token.

*Evidence: `backend/modules/hfauth/router.py:35`, `backend/modules/hfauth/router.py:132`.*

### Running offline

The assistant works fully offline if you use a **local provider** (Ollama, LM Studio, llama.cpp, or vLLM) and the all-MiniLM embedding weights are already cached; RAG retrieval is CPU-only and local. The cloud features (Gemini/OpenAI/Anthropic/Grok/Groq/OpenRouter chat, Suno, the Gemini proxy for vocal2midi/AI-compose, and HF auth) all require internet plus their respective keys.
