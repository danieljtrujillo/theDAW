# GANTASMOB0T Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate the GANTASMOB0T AI assistant into StableDAW as a floating orb + chat panel with multi-provider LLM streaming, RAG over project docs, and a Zustand action bridge that can control all app parameters.

**Architecture:** Port SunoHarvester's orb-kit (React) and assistant_chat_routes.py (FastAPI) into StableDAW. Add a ChromaDB-backed RAG system that indexes all project markdown docs. Build a Zustand-based action bridge so the LLM can control generation parameters, navigation, playback, and diagnostics via function calling — with both "full access" and "permission required" modes.

**Tech Stack:** React 19, TypeScript, Zustand 5, Tailwind v4, Vite 6, FastAPI, ChromaDB, sentence-transformers, httpx, SSE streaming.

---

## Task 1: Port key_pool.py to StableDAW backend

**Files:**
- Create: `backend/key_pool.py`

**Step 1: Copy key_pool.py and adapt paths**

Copy `C:\Users\skream\projects\SunoHarvester\src\api\key_pool.py` to `C:\Users\skream\projects\StableDAW\backend\key_pool.py`.

Change `PROJECT_ROOT` to point to StableDAW:

```python
PROJECT_ROOT = Path(__file__).resolve().parent.parent
POOL_FILE = PROJECT_ROOT / "data" / "api_key_pools.json"
```

Remove the `_read_frontend_env` method and its references (StableDAW doesn't have a `GANTASMO-SUNO-FRONTEND/.env`). In `_load_env_keys`, remove the `fe_env` logic — just use `os.environ.get(var, "")`.

**Step 2: Create data directory**

```bash
mkdir backend/../data
```

Ensure `data/` directory exists at project root for persisting key pools.

**Step 3: Verify import works**

```bash
cd C:\Users\skream\projects\StableDAW
python -c "from backend.key_pool import key_pool; print('OK:', type(key_pool))"
```

Expected: `OK: <class 'backend.key_pool.KeyPoolManager'>`

**Step 4: Commit**

```bash
git add backend/key_pool.py
git commit -m "feat(assistant): port key pool manager from SunoHarvester"
```

---

## Task 2: Port assistant_chat_routes.py to StableDAW backend

**Files:**
- Create: `backend/assistant_routes.py`

**Step 1: Copy and adapt the routes**

Copy `C:\Users\skream\projects\SunoHarvester\src\api\assistant_chat_routes.py` to `C:\Users\skream\projects\StableDAW\backend\assistant_routes.py`.

Changes required:

1. Fix import: `from src.api.key_pool import key_pool, _key_id` → `from backend.key_pool import key_pool, _key_id`

2. Update `PROJECT_CWD`:
```python
PROJECT_CWD = r"C:\Users\skream\projects\StableDAW"
```

3. Update OpenRouter headers:
```python
headers["HTTP-Referer"] = "https://stabledaw.local"
headers["X-Title"] = "StableDAW Assistant"
```

4. Remove the entire `# Route: audio generation (Lyria models via OpenRouter)` section (lines 1637-1760 in source) — the `LYRIA_MODELS`, `AudioGenRequest`, `get_audio_gen_models`, and `generate_audio` endpoint. These are Suno-specific.

5. Keep everything else: all providers, Claude Code CLI integration, Anthropic streamer, model discovery, key pool management routes.

**Step 2: Verify import works**

```bash
python -c "from backend.assistant_routes import router; print('Routes:', [r.path for r in router.routes])"
```

Expected: List of `/api/assistant/*` route paths.

**Step 3: Commit**

```bash
git add backend/assistant_routes.py
git commit -m "feat(assistant): port multi-provider chat API from SunoHarvester"
```

---

## Task 3: Build the RAG system

**Files:**
- Create: `backend/rag.py`

**Step 1: Install dependencies**

```bash
uv add chromadb sentence-transformers
```

**Step 2: Write backend/rag.py**

```python
"""
Mini RAG system — indexes StableDAW markdown docs into ChromaDB.

On startup, scans docs/, CLAUDE.md, and frontend/public/USER_GUIDE.md.
Chunks by markdown ## headers. Embeds with all-MiniLM-L6-v2.
Retrieves top-5 chunks per query with source citations.
"""

import hashlib
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAG_INDEX_DIR = PROJECT_ROOT / "backend" / "rag_index"

DOC_PATHS = [
    PROJECT_ROOT / "CLAUDE.md",
    PROJECT_ROOT / "docs" / "USER_GUIDE.md",
    PROJECT_ROOT / "docs" / "UI" / "hover-text-guide.md",
    PROJECT_ROOT / "docs" / "UI" / "ui-controls-guide.md",
    PROJECT_ROOT / "docs" / "UI" / "model-overview.md",
    PROJECT_ROOT / "docs" / "workflows" / "lora.md",
    PROJECT_ROOT / "docs" / "workflows" / "inference.md",
    PROJECT_ROOT / "docs" / "workflows" / "autoencoder.md",
    PROJECT_ROOT / "docs" / "windows" / "setup-guide.md",
    PROJECT_ROOT / "docs" / "windows" / "troubleshooting.md",
    PROJECT_ROOT / "frontend" / "public" / "USER_GUIDE.md",
]

_collection = None
_last_indexed_hash: Optional[str] = None


def _compute_docs_hash() -> str:
    h = hashlib.md5()
    for p in sorted(DOC_PATHS):
        if p.exists():
            h.update(f"{p}:{p.stat().st_mtime}".encode())
    return h.hexdigest()


def _chunk_markdown(text: str, source: str) -> list[dict]:
    sections = re.split(r'^(#{1,3}\s+.+)$', text, flags=re.MULTILINE)
    chunks = []
    current_heading = source
    current_body = ""

    for part in sections:
        part = part.strip()
        if not part:
            continue
        if re.match(r'^#{1,3}\s+', part):
            if current_body.strip():
                chunks.append({
                    "text": f"# {current_heading}\n\n{current_body.strip()}",
                    "source": source,
                    "section": current_heading,
                })
            current_heading = part.lstrip('#').strip()
            current_body = ""
        else:
            current_body += part + "\n"

    if current_body.strip():
        chunks.append({
            "text": f"# {current_heading}\n\n{current_body.strip()}",
            "source": source,
            "section": current_heading,
        })

    return chunks


def initialize_rag(force: bool = False) -> int:
    global _collection, _last_indexed_hash

    import chromadb
    from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

    current_hash = _compute_docs_hash()
    if not force and _last_indexed_hash == current_hash and _collection is not None:
        logger.info("[RAG] Index is current, skipping re-index")
        return 0

    logger.info("[RAG] Indexing documentation...")
    ef = SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2",
        device="cpu",
    )
    client = chromadb.PersistentClient(path=str(RAG_INDEX_DIR))

    try:
        client.delete_collection("stabledaw_docs")
    except Exception:
        pass

    _collection = client.get_or_create_collection(
        name="stabledaw_docs",
        embedding_function=ef,
        metadata={"hnsw:space": "cosine"},
    )

    all_chunks = []
    for doc_path in DOC_PATHS:
        if not doc_path.exists():
            logger.warning("[RAG] Skipping missing doc: %s", doc_path)
            continue
        text = doc_path.read_text(encoding="utf-8", errors="replace")
        rel_path = str(doc_path.relative_to(PROJECT_ROOT))
        chunks = _chunk_markdown(text, rel_path)
        all_chunks.extend(chunks)

    if not all_chunks:
        logger.warning("[RAG] No chunks to index")
        return 0

    _collection.add(
        ids=[f"chunk_{i}" for i in range(len(all_chunks))],
        documents=[c["text"] for c in all_chunks],
        metadatas=[{"source": c["source"], "section": c["section"]} for c in all_chunks],
    )

    _last_indexed_hash = current_hash
    logger.info("[RAG] Indexed %d chunks from %d documents", len(all_chunks), len(DOC_PATHS))
    return len(all_chunks)


def retrieve(query: str, n_results: int = 5) -> list[dict]:
    if _collection is None:
        return []

    results = _collection.query(query_texts=[query], n_results=n_results)

    chunks = []
    for i in range(len(results["documents"][0])):
        chunks.append({
            "text": results["documents"][0][i],
            "source": results["metadatas"][0][i]["source"],
            "section": results["metadatas"][0][i]["section"],
            "distance": results["distances"][0][i] if results.get("distances") else None,
        })
    return chunks


def format_context(chunks: list[dict]) -> str:
    if not chunks:
        return ""

    parts = ["## Relevant Documentation\n"]
    for i, chunk in enumerate(chunks, 1):
        parts.append(f"### [{chunk['source']}] {chunk['section']}\n{chunk['text']}\n")
    return "\n".join(parts)
```

**Step 3: Test RAG indexing**

```bash
python -c "
from backend.rag import initialize_rag, retrieve, format_context
n = initialize_rag()
print(f'Indexed {n} chunks')
results = retrieve('How do I set CFG scale for ARC models?')
for r in results:
    print(f'  [{r[\"source\"]}] {r[\"section\"]} (dist={r[\"distance\"]:.3f})')
print(format_context(results)[:500])
"
```

Expected: ~100 chunks indexed, relevant results about CFG scale.

**Step 4: Commit**

```bash
git add backend/rag.py
git commit -m "feat(assistant): add mini RAG system with ChromaDB + sentence-transformers"
```

---

## Task 4: Integrate RAG into assistant routes + mount in server.py

**Files:**
- Modify: `backend/assistant_routes.py`
- Modify: `backend/server.py`

**Step 1: Add RAG injection to the chat endpoint**

In `backend/assistant_routes.py`, add at the top:

```python
from backend.rag import retrieve, format_context
```

In the `chat_stream` endpoint function, before dispatching to the provider streamer, inject RAG context into the system message. Add this block after `provider = req.provider or "gemini"`:

```python
# Inject RAG context into the first system message
if req.messages:
    user_text = ""
    for msg in reversed(req.messages):
        if msg.role == "user":
            user_text = _extract_text(msg.content)
            break
    if user_text:
        rag_chunks = retrieve(user_text, n_results=5)
        rag_context = format_context(rag_chunks)
        if rag_context:
            system_msg = ChatMessage(role="system", content=STABLEDAW_SYSTEM_PROMPT + "\n\n" + rag_context)
            req.messages = [system_msg] + list(req.messages)
```

Add `STABLEDAW_SYSTEM_PROMPT` constant (see Task 8 for the full prompt — for now use a placeholder):

```python
STABLEDAW_SYSTEM_PROMPT = "You are the StableDAW Assistant, an expert in Stable Audio 3 audio generation."
```

**Step 2: Mount assistant router in server.py**

Add at the end of `backend/server.py`:

```python
from backend.assistant_routes import router as assistant_router
app.include_router(assistant_router)
```

**Step 3: Initialize RAG on startup**

Add to the existing `load_model` startup event in `backend/server.py`:

```python
from backend.rag import initialize_rag

# Inside load_model(), after pipeline is loaded:
try:
    n_chunks = initialize_rag()
    logger.info("RAG indexed %d chunks", n_chunks)
except Exception as e:
    logger.warning("RAG initialization failed (non-fatal): %s", e)
```

Add a reindex endpoint in `backend/assistant_routes.py`:

```python
@router.get("/reindex")
async def reindex_rag():
    from backend.rag import initialize_rag
    n = initialize_rag(force=True)
    return {"status": "ok", "chunks_indexed": n}
```

**Step 4: Add Vite proxy for /api/assistant**

The existing `vite.config.ts` proxy for `/api` already covers `/api/assistant/*` — no change needed.

**Step 5: Commit**

```bash
git add backend/assistant_routes.py backend/server.py
git commit -m "feat(assistant): mount assistant API + RAG in StableDAW backend"
```

---

## Task 5: Port orb-kit frontend components

**Files:**
- Create: `frontend/src/orb-kit/index.ts`
- Create: `frontend/src/orb-kit/OrbChatAssembled.tsx`
- Create: `frontend/src/orb-kit/react/GantasmoOrb.tsx`
- Create: `frontend/src/orb-kit/chat/index.ts`
- Create: `frontend/src/orb-kit/chat/useOrbChat.ts`
- Create: `frontend/src/orb-kit/chat/OrbChatPanel.tsx`
- Create: `frontend/src/orb-kit/chat/orb-chat.css`
- Create: `frontend/src/orb-kit/styles/gantasmo-orb.css`
- Create: `frontend/src/orb-kit/ProviderModelSelector.tsx`

**Step 1: Create directory structure**

```bash
mkdir -p frontend/src/orb-kit/react frontend/src/orb-kit/chat frontend/src/orb-kit/styles
```

**Step 2: Copy files with modifications**

Copy each file from `C:\Users\skream\projects\SunoHarvester\GANTASMO-SUNO-FRONTEND\orb-kit\` into `frontend/src/orb-kit/`, with these changes:

**GantasmoOrb.tsx** — Copy as-is, no changes needed.

**ProviderModelSelector.tsx** — Copy from `C:\Users\skream\projects\SunoHarvester\GANTASMO-SUNO-FRONTEND\components\Assistant\ProviderModelSelector.tsx` into `frontend/src/orb-kit/ProviderModelSelector.tsx`. No changes needed (it uses lucide-react which StableDAW already has, and Tailwind which StableDAW already has).

**useOrbChat.ts** — Copy and change import:
```typescript
// OLD: import type { ModelInfo } from '../../components/Assistant/ProviderModelSelector';
// NEW:
import type { ModelInfo } from '../ProviderModelSelector';
```

**OrbChatPanel.tsx** — Copy with these changes:
1. Fix import: `import { ProviderModelSelector } from '../ProviderModelSelector';`
2. Change default title: `title = 'StableDAW Assistant'`
3. Change default subtitle: `subtitle = 'Stable Audio 3 expert'`
4. Remove the entire `settingsTab === 'audio'` block (lines 159-185 in source)
5. Remove `'audio'` from the settings tab list — change `(['model', 'audio', 'keys'] as const)` to `(['model', 'keys'] as const)`
6. Remove `audioGenModel`, `audioGenModels`, and their state/effects (lines 40-50 in source)
7. Remove the audio tab button styling logic (the pink color for audio tab)

**OrbChatAssembled.tsx** — Copy and fix imports to use local paths.

**index.ts** — Rewrite to use local paths:
```typescript
export { GantasmoOrb } from './react/GantasmoOrb';
export type { GantasmoOrbProps } from './react/GantasmoOrb';
export { OrbChatAssembled } from './OrbChatAssembled';
export type { OrbChatAssembledProps } from './OrbChatAssembled';
export { useOrbChat } from './chat/useOrbChat';
export type { OrbChatMessage, OrbProvider, OrbChatConfig, OrbChatState } from './chat/useOrbChat';
export { OrbChatPanel } from './chat/OrbChatPanel';
export type { OrbChatPanelProps } from './chat/OrbChatPanel';
export { ProviderModelSelector } from './ProviderModelSelector';
export type { ModelInfo, Capability, ProviderOption, ProviderModelSelectorProps } from './ProviderModelSelector';
```

**chat/index.ts** — Copy as-is.

**CSS files** — Copy `orb-chat.css` and `gantasmo-orb.css` as-is. The scoped `.gantasmo-orb-theme` class prevents any conflicts with Tailwind.

**Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add frontend/src/orb-kit/
git commit -m "feat(assistant): port orb-kit UI components to StableDAW"
```

---

## Task 6: Build the action bridge store

**Files:**
- Create: `frontend/src/state/assistantBridgeStore.ts`

**Step 1: Write the action bridge**

This store handles:
- Mode toggle (full access vs permission mode)
- Pending action queue (for permission mode)
- Action execution against other Zustand stores

```typescript
import { create } from 'zustand';
import { useGenerateParamsStore } from './generateParamsStore';
import { useGenerateStore } from './generateStore';
import { usePlayerStore } from './playerStore';
import { usePlaybackStore } from './playbackStore';
import { logInfo } from './logStore';

export type ActionMode = 'full_access' | 'permission_required';

export interface AssistantAction {
    id: string;
    type: string;
    params: Record<string, unknown>;
    description: string;
    status: 'pending' | 'approved' | 'rejected' | 'executed';
}

interface AssistantBridgeState {
    mode: ActionMode;
    pendingActions: AssistantAction[];
    setMode: (mode: ActionMode) => void;
    executeAction: (action: AssistantAction) => string;
    approveAction: (id: string) => string;
    rejectAction: (id: string) => void;
    clearPending: () => void;
}

function runAction(action: AssistantAction): string {
    const { type, params } = action;
    const paramsStore = useGenerateParamsStore.getState();

    switch (type) {
        case 'set_prompt':
            paramsStore.setField('prompt', String(params.prompt || ''));
            return `Prompt set to: "${String(params.prompt || '').slice(0, 60)}"`;

        case 'set_negative_prompt':
            paramsStore.setField('negativePrompt', String(params.prompt || ''));
            return `Negative prompt set`;

        case 'set_model':
            paramsStore.setField('model', String(params.model || 'medium'));
            return `Model set to: ${params.model}`;

        case 'set_duration':
            paramsStore.setField('duration', Number(params.duration || 30));
            return `Duration set to: ${params.duration}s`;

        case 'set_steps':
            paramsStore.setField('steps', Number(params.steps || 8));
            return `Steps set to: ${params.steps}`;

        case 'set_cfg':
            paramsStore.setField('cfg', Number(params.cfg || 1.0));
            return `CFG scale set to: ${params.cfg}`;

        case 'set_seed':
            paramsStore.setField('seed', Number(params.seed ?? -1));
            return `Seed set to: ${params.seed}`;

        case 'set_shift_mode':
            paramsStore.setField('shiftMode', String(params.mode || 'LogSNR'));
            return `Shift mode set to: ${params.mode}`;

        case 'set_batch':
            paramsStore.setField('batch', Number(params.batch || 1));
            return `Batch size set to: ${params.batch}`;

        case 'set_sampler':
            paramsStore.setField('samplerType', String(params.sampler || 'pingpong'));
            return `Sampler set to: ${params.sampler}`;

        case 'set_params':
            paramsStore.patch(params as any);
            return `Multiple parameters updated`;

        case 'start_generation': {
            const p = useGenerateParamsStore.getState();
            useGenerateStore.getState().submitGeneration({
                prompt: p.prompt,
                negativePrompt: p.negativePrompt,
                model: p.model,
                duration: p.duration,
                steps: p.steps,
                cfg: p.cfg,
                seed: p.seed,
                batch: p.batch,
                initNoise: p.initNoise,
                initType: p.initType,
                initAudioFile: p.initAudioFile,
                inpaintAudioFile: p.inpaintAudioFile,
                inpaintEnabled: p.inpaintEnabled,
                maskStart: p.maskStart,
                maskEnd: p.maskEnd,
            });
            return 'Generation started';
        }

        case 'abort_generation':
            useGenerateStore.getState().cancelPolling();
            return 'Generation aborted';

        case 'play':
            usePlayerStore.getState().play();
            return 'Playback started';

        case 'pause':
            usePlayerStore.getState().pause();
            return 'Playback paused';

        case 'stop':
            usePlayerStore.getState().stop();
            return 'Playback stopped';

        case 'set_volume':
            usePlaybackStore.getState().setVolume(Number(params.volume ?? 0.8));
            return `Volume set to: ${params.volume}`;

        case 'navigate': {
            // Navigation is handled by dispatching a custom event
            // Shell.tsx will listen for this
            const tab = String(params.tab || 'create');
            window.dispatchEvent(new CustomEvent('stabledaw:navigate', { detail: { tab } }));
            return `Navigated to: ${tab}`;
        }

        case 'get_status': {
            const gen = useGenerateStore.getState();
            const p = useGenerateParamsStore.getState();
            return JSON.stringify({
                generating: gen.isGenerating,
                jobStatus: gen.jobStatus,
                model: p.model,
                prompt: p.prompt.slice(0, 100),
                duration: p.duration,
                steps: p.steps,
                cfg: p.cfg,
                seed: p.seed,
            });
        }

        default:
            return `Unknown action: ${type}`;
    }
}

export const useAssistantBridgeStore = create<AssistantBridgeState>()((set, get) => ({
    mode: 'full_access',
    pendingActions: [],

    setMode: (mode) => set({ mode }),

    executeAction: (action) => {
        const { mode } = get();

        if (mode === 'permission_required') {
            set((state) => ({
                pendingActions: [...state.pendingActions, { ...action, status: 'pending' }],
            }));
            return `Action "${action.description}" requires your approval.`;
        }

        logInfo('assistant', `Executing: ${action.description}`);
        const result = runAction(action);
        return result;
    },

    approveAction: (id) => {
        const action = get().pendingActions.find((a) => a.id === id);
        if (!action) return 'Action not found';

        set((state) => ({
            pendingActions: state.pendingActions.map((a) =>
                a.id === id ? { ...a, status: 'executed' } : a
            ),
        }));

        logInfo('assistant', `Approved: ${action.description}`);
        return runAction(action);
    },

    rejectAction: (id) => {
        set((state) => ({
            pendingActions: state.pendingActions.map((a) =>
                a.id === id ? { ...a, status: 'rejected' } : a
            ),
        }));
    },

    clearPending: () => set({ pendingActions: [] }),
}));
```

**Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add frontend/src/state/assistantBridgeStore.ts
git commit -m "feat(assistant): add Zustand action bridge with full-access and permission modes"
```

---

## Task 7: Write the StableDAW system prompt

**Files:**
- Modify: `backend/assistant_routes.py` (replace placeholder prompt)

**Step 1: Write the full system prompt**

Replace `STABLEDAW_SYSTEM_PROMPT` in `backend/assistant_routes.py` with:

```python
STABLEDAW_SYSTEM_PROMPT = """You are the StableDAW Assistant — an expert AI companion for the Stable Audio 3 audio generation system.

## Your Capabilities
- Answer any question about StableDAW, Stable Audio 3, and audio generation
- Explain every parameter and what it does
- Recommend optimal settings for different use cases
- Diagnose issues (CUDA, VRAM, model loading, audio artifacts)
- Control the app: set parameters, start/stop generation, navigate tabs, manage playback

## Stable Audio 3 Architecture
Two-stage pipeline:
1. DiT (Diffusion Transformer) generates latents from text prompts using T5Gemma conditioning
2. SAME Autoencoder decodes latents to 44.1kHz stereo audio at 4096x downsampling

Models: Small (433M), Medium (1.4B). ARC checkpoints (post-trained, 8-step, cfg_scale=1). RF checkpoints (base, for LoRA training, cfg_scale=7).

## Key Parameters
- **Model**: small, medium (ARC), small-rf, medium-rf (RF/base)
- **Duration**: 1-180 seconds. Determines latent sequence length directly.
- **Steps**: Diffusion sampling steps. ARC default=8, RF needs more (20-50).
- **CFG Scale**: Classifier-free guidance. ARC=1.0 (no guidance needed). RF=7.0.
- **Seed**: -1 for random, or fixed integer for reproducibility.
- **Sampler**: pingpong (default), euler, rk4, dpmpp.
- **Shift Mode**: LogSNR (default), Flux, Full, None. Warps timestep schedule based on sequence length.
- **APG Scale**: Adaptive Projected Guidance strength. Default 1.0.
- **Init Audio**: Audio-to-audio mode. Upload source audio + set noise level (0=keep original, 1=full noise).
- **Inpainting**: Upload audio, set mask start/end to regenerate a specific section.
- **LoRA**: Load trained adapters with per-slot weight control. Supports stacking multiple LoRAs.

## Communication Style
- Professional, direct, knowledgeable
- Give specific parameter values, not vague suggestions
- When recommending settings, explain WHY
- If the user's request is ambiguous, ask one clarifying question
- For errors: diagnose first, then suggest fixes
"""
```

**Step 2: Commit**

```bash
git add backend/assistant_routes.py
git commit -m "feat(assistant): add comprehensive StableDAW system prompt"
```

---

## Task 8: Mount the assistant in App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/index.css` (import orb-kit CSS)

**Step 1: Import and render OrbChatAssembled in App.tsx**

```tsx
import { useEffect } from 'react';
import { Shell } from './components/layout/Shell';
import { PlayerFooter } from './components/audio/PlayerFooter';
import { OrbChatAssembled } from './orb-kit';
import { logInfo } from './state/logStore';

import './orb-kit/styles/gantasmo-orb.css';
import './orb-kit/chat/orb-chat.css';

export default function App() {
  useEffect(() => {
    logInfo('system', 'StableDAW UI initialized');
  }, []);

  return (
    <>
      <Shell />
      <PlayerFooter />
      <OrbChatAssembled
        title="StableDAW Assistant"
        subtitle="Stable Audio 3 expert"
        apiBaseUrl="/api/assistant"
      />
    </>
  );
}
```

**Step 2: Verify the app builds**

```bash
cd frontend && npm run build
```

**Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(assistant): mount GANTASMOB0T orb in StableDAW UI"
```

---

## Task 9: Add navigation event listener to Shell.tsx

**Files:**
- Modify: `frontend/src/components/layout/Shell.tsx`

**Step 1: Add event listener for assistant navigation commands**

In Shell.tsx, inside the `Shell` component, add after the existing `useEffect` for health checks:

```tsx
useEffect(() => {
    const handler = (e: Event) => {
        const tab = (e as CustomEvent).detail?.tab;
        if (tab && ['create', 'edit', 'train', 'library'].includes(tab)) {
            setActiveView(tab);
        }
    };
    window.addEventListener('stabledaw:navigate', handler);
    return () => window.removeEventListener('stabledaw:navigate', handler);
}, []);
```

**Step 2: Commit**

```bash
git add frontend/src/components/layout/Shell.tsx
git commit -m "feat(assistant): add navigation event listener for assistant tab control"
```

---

## Task 10: Add Python dependencies

**Files:**
- Modify: `pyproject.toml`

**Step 1: Add chromadb and sentence-transformers to pyproject.toml**

Add to the `[project.dependencies]` list:

```toml
"chromadb>=1.0.0",
"sentence-transformers>=3.0.0",
```

**Step 2: Sync**

```bash
uv sync
```

**Step 3: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "feat(assistant): add chromadb + sentence-transformers dependencies"
```

---

## Task 11: Add backend __init__.py and fix imports

**Files:**
- Create: `backend/__init__.py` (empty, makes backend a Python package)

**Step 1: Create __init__.py**

```bash
touch backend/__init__.py
```

**Step 2: Verify full backend starts**

```bash
cd C:\Users\skream\projects\StableDAW
uvicorn backend.server:app --host 0.0.0.0 --port 8600
```

Verify in another terminal:

```bash
curl http://localhost:8600/api/assistant/providers
```

Expected: JSON with provider list.

**Step 3: Commit**

```bash
git add backend/__init__.py
git commit -m "chore: add backend __init__.py for package imports"
```

---

## Task 12: Integration smoke test

**Step 1: Start the backend**

```bash
uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload
```

**Step 2: Start the frontend**

```bash
cd frontend && npm run dev
```

**Step 3: Test in browser**

1. Open `http://localhost:4173` (or whatever port Vite uses)
2. Verify the floating orb appears in the bottom-left corner
3. Click the orb — chat panel should open
4. Click the gear icon — provider/model selector should appear
5. Type "What models are available?" — should get a response about Small/Medium/ARC/RF
6. Type "Set CFG to 7" — should update the parameter (in full access mode)
7. Type "How do I use LoRA?" — should get RAG-enriched answer with doc citations

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: GANTASMOB0T integration complete — AI assistant with RAG + multi-provider + action bridge"
```

---

## Execution Notes

- Tasks 1-4 are backend (Python). Tasks 5-9 are frontend (TypeScript). Task 10-11 are setup. Task 12 is verification.
- Tasks 1-3 are independent and can be parallelized.
- Task 4 depends on Tasks 1-3.
- Tasks 5-6 are independent and can be parallelized.
- Task 7 depends on Task 4.
- Task 8 depends on Tasks 5-6.
- Task 9 depends on Task 8.
- Task 10 should be done early (before Task 3).
- Task 12 depends on all other tasks.

### Dependency Graph

```
Task 10 (deps) ──┐
Task 1 (key_pool) ─┤
Task 2 (routes) ───┼── Task 4 (mount+RAG) ── Task 7 (prompt) ──┐
Task 3 (rag.py) ───┘                                            │
Task 11 (__init__) ─────────────────────────────────────────────┤
Task 5 (orb-kit) ───┬── Task 8 (App.tsx) ── Task 9 (Shell) ────┼── Task 12 (test)
Task 6 (bridge) ────┘                                           │
```
