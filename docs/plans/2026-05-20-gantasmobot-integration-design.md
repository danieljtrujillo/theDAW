# GANTASMOB0T Integration Design for StableDAW

**Date**: 2026-05-20
**Status**: Approved

## Summary

Integrate the GANTASMOB0T AI assistant into StableDAW's React frontend as the ultimate app companion. The assistant answers questions about Stable Audio 3, advises on generation parameters, controls UI elements, searches the web, and diagnoses app issues. Powered by a mini RAG system over all project documentation.

## Architecture

Three layers:

### 1. Backend — Multi-Provider Assistant API

Port SunoHarvester's `assistant_chat_routes.py` into StableDAW's FastAPI backend (port 8600). Mounted at `/api/assistant/*`.

**Endpoints:**
- `POST /api/assistant/chat` — SSE-streamed chat completions (all providers)
- `GET /api/assistant/providers` — Provider catalog with availability
- `GET /api/assistant/models/{provider_id}` — Model discovery per provider
- `GET /api/assistant/reindex` — Manual RAG re-index trigger

**Providers supported:** Gemini, OpenAI, Anthropic, Grok (xAI), Groq, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM.

**Features:** SSE streaming, API key rotation, model discovery, conversation continuity via session IDs.

### 2. Backend — Mini RAG System

**Indexing (on startup):**
- Scan `docs/`, `CLAUDE.md`, `frontend/public/USER_GUIDE.md`
- Chunk by markdown headers (`##` sections), with metadata (source file, section title)
- Embed with `sentence-transformers/all-MiniLM-L6-v2` (CPU, 80MB)
- Store in ChromaDB (embedded mode, persisted to `backend/rag_index/`)
- Re-index on restart if doc mtimes changed

**Retrieval (per chat message):**
- Embed user question
- Retrieve top-5 relevant chunks
- Inject into system prompt as `## Relevant Documentation` with source citations
- ~100 total chunks covering all project documentation

**Documents indexed:**

| Source | Content |
|--------|---------|
| `docs/USER_GUIDE.md` | Master guide — UI, API, pipeline, troubleshooting |
| `docs/UI/hover-text-guide.md` | Every parameter's tooltip text |
| `docs/UI/ui-controls-guide.md` | Plain-English control explanations |
| `docs/UI/model-overview.md` | SAME/DiT architecture, checkpoint types |
| `docs/workflows/lora.md` | LoRA training, stacking, filtering |
| `docs/workflows/inference.md` | Python inference patterns |
| `docs/workflows/autoencoder.md` | Encode/decode workflows |
| `docs/windows/setup-guide.md` | Windows install steps |
| `docs/windows/troubleshooting.md` | Common Windows fixes |
| `CLAUDE.md` | Architecture overview |

### 3. Frontend — Orb-Kit UI

Port orb-kit from SunoHarvester into `frontend/src/orb-kit/`. Changes from source:

- Strip Suno-specific: audio gen tab, Lyria references, Suno titles
- Rebrand: "StableDAW Assistant" default title
- Inline `ProviderModelSelector` (copy into orb-kit, fix imports)
- Mount as floating overlay in `App.tsx` on all tabs

**Components:**
- `GantasmoOrb` — floating draggable orb (ghost-face SVG)
- `OrbChatPanel` — chat panel with provider/model selector, API key management
- `useOrbChat` hook — SSE streaming, provider switching, conversation state
- `OrbChatAssembled` — pre-wired combo

### 4. Frontend — Action Bridge

Zustand-powered bridge between LLM function calls and app state. Two modes toggled by user:

- **Full Access** — actions execute immediately against Zustand stores
- **Permission Mode** — actions show confirmation cards in chat before executing

**Action Catalog:**

| Category | Actions | Store |
|----------|---------|-------|
| Generation Params | set model, duration, steps, CFG, seed, shift mode, prompt, negative prompt | `generateParamsStore` |
| Generation Control | start generation, abort job | `generateStore` |
| LoRA | add/remove slot, set weight | `generateParamsStore` |
| Navigation | switch tab | `Shell.tsx` state |
| Studio | set macro values, select effect | `studioStore` |
| Playback | play/pause/stop, volume | `playerStore`, `playbackStore` |
| Diagnostics | health check, model info, logs, VRAM | `statusBarStore`, `logStore`, backend APIs |
| Library | search/filter, load audio | `libraryStore` |

### 5. System Prompt

Comprehensive prompt containing:
- Stable Audio 3 architecture (two-stage DiT + SAME pipeline)
- All parameter names, ranges, defaults, and effects
- Model descriptions (Small, Medium, ARC vs RF, SAME-S vs SAME-L)
- CFG guidance rules (ARC=1, RF=7)
- LoRA usage guide
- Inpainting workflow
- Common troubleshooting
- Available function-call actions with descriptions
- RAG-retrieved documentation chunks (injected per-query)

### 6. Web Search

Handled by provider-native capabilities. Most modern models (Gemini, Claude, GPT, Grok) support grounding/search natively. No custom search infrastructure.

## New Dependencies

**Python (backend):**
- `chromadb` — embedded vector store
- `sentence-transformers` — embedding model

**JavaScript (frontend):**
- None new (React 19, Tailwind v4, Zustand, lucide-react already present)

## Files

**New (~15):**
- `frontend/src/orb-kit/` — ported + cleaned orb-kit (~10 files)
- `backend/assistant_routes.py` — multi-provider chat API
- `backend/rag.py` — RAG indexing + retrieval
- `frontend/src/state/assistantBridgeStore.ts` — action bridge + mode toggle
- `frontend/src/orb-kit/stabledaw-system-prompt.ts` — system prompt
- `frontend/src/orb-kit/actionHandlers.ts` — maps function calls to Zustand actions

**Modified (~3):**
- `frontend/src/App.tsx` — mount orb-kit overlay
- `backend/server.py` — mount assistant router
- `pyproject.toml` — add chromadb + sentence-transformers
