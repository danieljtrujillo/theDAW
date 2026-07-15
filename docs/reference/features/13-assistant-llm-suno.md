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

Ask the assistant to do something ("switch to advanced", "set the prompt to epic orchestral and generate") and it drives the UI directly. Providers with native function calling receive an OpenAI-style tool schema (`theDAW_TOOLS`, converted to Anthropic tool format for Claude); other models emit `<action>{...}</action>` blocks the frontend executes. Actions cover navigation, prompt editing, every generation parameter, and generate/abort/status.

*Evidence: `backend/assistant_routes.py:1389`, `backend/assistant_routes.py:117`.*

### Claude Code agent mode

Selecting the **Claude Code** provider spawns the local `claude` CLI in `stream-json` mode. It defaults to `claude-opus-4-6` with a `claude-sonnet-4-6` fallback and `max` effort. `interactive`/`persistent` modes keep one warm process alive across messages; `resume`/`oneshot` spawn per message. The subprocess is bounded (10 MB stdout cap, 15-minute timeout, keepalive pings, and crash backoff after repeated failures). An optional underfit LoRA-trainer MCP is attached only for the underfit assistant profile.

*Evidence: `backend/assistant_routes.py:241`, `backend/assistant_routes.py:1050`, `backend/assistant_routes.py:716`.*

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
