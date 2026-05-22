# Advanced Workspace Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Advanced tab into a resizable 60/40 split workspace — generation panel (left) with prompt library, AI wand stub, and Send-to-DAW; editor panel (right) with categorized FFmpeg effects, drag-to-chain builder, and audio preview. No scrolling — everything fits the viewport. Dropdowns/menus may scroll internally.

**Architecture:** The Advanced workspace replaces the current single-panel AdvancedView with a horizontal ResizablePanel split. Left panel is the generation view (compacted). Right panel is a new EditorPanel component backed by the existing `useStudioStore` (which already calls `POST /api/studio/process`). Effect chain is local UI state — effects process sequentially by feeding each output as the next input. Prompt library uses localStorage via a new Zustand store.

**Tech Stack:** React 19, Zustand, Tailwind 4, existing WaveformPreview component, existing studioStore + editorStore, lucide-react icons.

**Key constraint:** NO SCROLLING on the main layout. All panels use `h-full overflow-hidden` with internal flex/grid that fits. Only dropdown menus and effect chain lists get `overflow-y-auto`.

---

### Task 1: Prompt Library Store

**Files:**
- Create: `frontend/src/state/promptLibraryStore.ts`

**Step 1: Create the store**

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SavedPrompt {
  id: string;
  label: string;
  prompt: string;
  negativePrompt: string;
  tags: string[];
  createdAt: string;
}

interface PromptLibraryState {
  prompts: SavedPrompt[];
  searchQuery: string;
  save: (p: Omit<SavedPrompt, 'id' | 'createdAt'>) => void;
  remove: (id: string) => void;
  setSearch: (q: string) => void;
  getFiltered: () => SavedPrompt[];
}

export const usePromptLibraryStore = create<PromptLibraryState>()(
  persist(
    (set, get) => ({
      prompts: [],
      searchQuery: '',
      save: (p) => set((s) => ({
        prompts: [{ ...p, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...s.prompts],
      })),
      remove: (id) => set((s) => ({ prompts: s.prompts.filter((x) => x.id !== id) })),
      setSearch: (searchQuery) => set({ searchQuery }),
      getFiltered: () => {
        const { prompts, searchQuery } = get();
        if (!searchQuery.trim()) return prompts;
        const q = searchQuery.toLowerCase();
        return prompts.filter(
          (p) => p.label.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
        );
      },
    }),
    { name: 'stabledaw-prompt-library' },
  ),
);
```

**Step 2: Commit**

```bash
git add frontend/src/state/promptLibraryStore.ts
git commit -m "feat: add prompt library zustand store with localStorage persistence"
```

---

### Task 2: Effect Chain Store

**Files:**
- Create: `frontend/src/state/effectChainStore.ts`

**Step 1: Create the store**

The store holds an ordered list of chain entries (effect name + params). Processing runs sequentially through studioStore.

```typescript
import { create } from 'zustand';

// All 24 effects grouped into categories
export const EFFECT_CATEGORIES = {
  'Dynamics': ['compression', 'volume', 'loudnorm', 'mastering_chain'],
  'EQ & Tone': ['highpass', 'lowpass', 'eq_mid', 'sub_exciter'],
  'Space': ['reverb_delay', 'delay', 'echo', 'stereo_widener'],
  'Cleanup': ['denoise', 'declick', 'silence_remove'],
  'Creative': ['lofi_vinyl', 'pitch_shift', 'tempo', 'vocal_processing', 'phase_isolation'],
  'Fade': ['fade'],
  'Export': ['export_flac', 'export_mp3', 'export_aac', 'export_opus'],
} as const;

// Default params per effect (matching backend EFFECT_PARAM_BOUNDS midpoints)
export const EFFECT_DEFAULTS: Record<string, Record<string, number>> = {
  mastering_chain: { lowBoost: 0, highBoost: 0, limiterCeiling: 0.95, targetLUFS: -14 },
  compression: { attack: 0.1, decay: 0.3 },
  highpass: { frequency: 80 },
  volume: { level: 1.0 },
  tempo: { rate: 1.0 },
  vocal_processing: { highpassFreq: 80, presenceBoost: 2, targetLUFS: -16 },
  lofi_vinyl: { degradation: 3, lowpassFreq: 8000 },
  stereo_widener: { delayMs: 15 },
  reverb_delay: { delayMs: 400, decay: 0.5, reverbDecay: 0.4 },
  sub_exciter: { subBoost: 4, trebleBoost: 2 },
  phase_isolation: { cancelAmount: 0.8 },
  eq_mid: { frequency: 1000, width: 500, gain: 0 },
  loudnorm: { targetLUFS: -14, truePeak: -1 },
  lowpass: { frequency: 8000 },
  pitch_shift: { shift: 0 },
  delay: { leftMs: 250, rightMs: 375 },
  echo: { delayMs: 300, decay: 0.4 },
  fade: { fadeInDuration: 1, fadeOutDuration: 2 },
  denoise: { noiseReduction: 20 },
  declick: { windowSize: 30 },
  silence_remove: { threshold: -40 },
  export_flac: { compressionLevel: 5 },
  export_mp3: { bitrate: 320 },
  export_aac: { bitrate: 256 },
  export_opus: { bitrate: 128 },
};

export interface ChainEntry {
  id: string;
  effect: string;
  params: Record<string, number>;
  enabled: boolean;
}

interface EffectChainState {
  chain: ChainEntry[];
  addEffect: (effect: string) => void;
  removeEffect: (id: string) => void;
  updateParams: (id: string, params: Record<string, number>) => void;
  toggleEnabled: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
  clearChain: () => void;
}

export const useEffectChainStore = create<EffectChainState>()((set) => ({
  chain: [],
  addEffect: (effect) =>
    set((s) => ({
      chain: [...s.chain, { id: crypto.randomUUID(), effect, params: { ...(EFFECT_DEFAULTS[effect] || {}) }, enabled: true }],
    })),
  removeEffect: (id) => set((s) => ({ chain: s.chain.filter((e) => e.id !== id) })),
  updateParams: (id, params) =>
    set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, params } : e)) })),
  toggleEnabled: (id) =>
    set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
  reorder: (from, to) =>
    set((s) => {
      const next = [...s.chain];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { chain: next };
    }),
  clearChain: () => set({ chain: [] }),
}));
```

**Step 2: Commit**

```bash
git add frontend/src/state/effectChainStore.ts
git commit -m "feat: add effect chain store with categories and defaults for all 24 FFmpeg effects"
```

---

### Task 3: Compact Generation Panel (left side)

**Files:**
- Create: `frontend/src/views/AdvancedGenPanel.tsx`

This is the current AdvancedView content, compacted to fit 60% width with no scrolling:
- Prompt textareas: 40px min-height (down from 68px)
- Prompt Library: inline section below prompts — save button, search input, scrollable dropdown of saved prompts (the ONLY scrollable element), click to load
- AI Wand: stub button next to prompt textarea (placeholder handler, wire LLM later)
- Controls row: tighter, single line
- Init Audio / Inpainting / Output: compact row below controls
- Schedule Shift / Sampler: compact row at bottom
- "Send to DAW" button on Output card — calls `editorStore.addTrack()` + `addClipToTrack()`
- "Send to Editor" button on Output card — loads audio into the right-side editor panel
- Layout uses `h-full flex flex-col` with rows using `flex-shrink-0` for fixed rows and `min-h-0` for flexible ones

**Step 1: Create AdvancedGenPanel.tsx**

Port all content from current AdvancedView.tsx but:
- Shrink prompt textarea min-heights to 40px
- Add PromptLibrary inline section (save button, search, dropdown list max-h-[120px] overflow-y-auto)
- Add Wand stub button (Wand2 icon, onClick logs "AI enhancement coming soon")
- Add "→ DAW" button to Output card that creates new track + clip in editorStore
- Add "→ Editor" button to Output card that sets the editor panel's source file
- All three grid rows use compact spacing
- Root element: `h-full flex flex-col overflow-hidden` (no scroll)

**Step 2: Commit**

```bash
git add frontend/src/views/AdvancedGenPanel.tsx
git commit -m "feat: compact generation panel with prompt library, wand stub, send-to-DAW/editor"
```

---

### Task 4: Editor Panel (right side)

**Files:**
- Create: `frontend/src/views/AdvancedEditorPanel.tsx`

Layout (top to bottom, no scrolling, flex-col h-full):
1. **Source bar** (flex-shrink-0, ~32px): filename display, upload button, clear button, drop zone for library drag
2. **Waveform** (flex-shrink-0, 48px): WaveformPreview of loaded source + MiniPlayer
3. **Effect Palette** (flex-shrink-0, ~120px): 7 category tabs across top (Dynamics, EQ & Tone, Space, Cleanup, Creative, Fade, Export). Each tab shows its effects as clickable chips. Click adds to chain.
4. **Chain Builder** (flex-1, min-h-0, overflow-y-auto — this is the ONLY scrollable area): ordered list of chain entries. Each entry shows effect name, enabled toggle, param sliders, remove button. Drag handle for reorder.
5. **Process bar** (flex-shrink-0, ~36px): "Process Chain" button, output format dropdown, progress indicator

Uses `useStudioStore.processAudio()` for each chain step sequentially. After chain completes, shows output waveform replacing source waveform with "Use as Source" button to feed back.

**Step 1: Create AdvancedEditorPanel.tsx**

```
Root: h-full flex flex-col overflow-hidden

SourceBar: flex-shrink-0
  - File name / "Drop audio here" / Upload button / Clear
  - onDrop handles both File drops and library drags (same fileFromDrop pattern)

WaveformArea: flex-shrink-0 h-12
  - WaveformPreview + MiniPlayer when source loaded

EffectPalette: flex-shrink-0
  - Category tabs (horizontal, text-[8px] mono uppercase)
  - Effect chips in active category (grid, click to add to chain)

ChainBuilder: flex-1 min-h-0 overflow-y-auto  ← ONLY scrollable element
  - Each ChainEntry: hardware-card with effect name, on/off toggle, param controls, × remove
  - Drag handle for reorder (simple button-based up/down for v1)

ProcessBar: flex-shrink-0
  - Output format select (wav/flac/mp3/ogg)
  - "Process Chain" btn-primary
  - Runs chain sequentially: for each enabled entry, call studioStore.processAudio(), feed output as next source
```

**Step 2: Commit**

```bash
git add frontend/src/views/AdvancedEditorPanel.tsx
git commit -m "feat: editor panel with categorized effects, chain builder, sequential processing"
```

---

### Task 5: Split Layout Wrapper

**Files:**
- Modify: `frontend/src/views/AdvancedView.tsx` — replace contents with split layout
- Modify: `frontend/src/components/layout/DAWCenterPanel.tsx` — no changes needed (already renders AdvancedView)

**Step 1: Rewrite AdvancedView as split container**

```tsx
import React, { useState, useRef, useEffect } from 'react';
import { AdvancedGenPanel } from './AdvancedGenPanel';
import { AdvancedEditorPanel } from './AdvancedEditorPanel';
import { GripVertical } from 'lucide-react';

export const AdvancedView: React.FC = () => {
  const [leftWidth, setLeftWidth] = useState(60); // percentage
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.max(35, Math.min(75, pct)));
    };
    const onUp = () => { dragging.current = false; document.body.style.cursor = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div style={{ width: `${leftWidth}%` }} className="h-full overflow-hidden flex-shrink-0">
        <AdvancedGenPanel />
      </div>
      <div
        className="w-1.5 flex-shrink-0 flex items-center justify-center cursor-col-resize group hover:bg-purple-500/20 transition-colors"
        onMouseDown={() => { dragging.current = true; document.body.style.cursor = 'col-resize'; }}
      >
        <GripVertical className="w-3 h-3 text-zinc-700 group-hover:text-purple-400" />
      </div>
      <div className="flex-1 h-full overflow-hidden min-w-0">
        <AdvancedEditorPanel />
      </div>
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add frontend/src/views/AdvancedView.tsx
git commit -m "feat: resizable 60/40 split layout for advanced workspace"
```

---

### Task 6: Wire Send-to-DAW

**Files:**
- Modify: `frontend/src/views/AdvancedGenPanel.tsx` — Output card "→ DAW" button

**Step 1: Implement the handler**

In the Output card, the "→ DAW" button:

```typescript
import { useEditorStore } from '../state/editorStore';

// Inside component:
const addTrack = useEditorStore((s) => s.addTrack);
const addClip = useEditorStore((s) => s.addClipToTrack);

const handleSendToDaw = async () => {
  if (!lastAudioUrl) return;
  const res = await fetch(lastAudioUrl);
  const blob = await res.blob();
  const trackId = addTrack({ name: p.prompt.slice(0, 30) || 'Generated' });
  const audio = new Audio(lastAudioUrl);
  await new Promise((resolve) => { audio.onloadedmetadata = resolve; audio.onerror = resolve; });
  addClip({
    trackId,
    label: p.prompt.slice(0, 40) || 'Generated Audio',
    audioBlob: blob,
    mimeType: blob.type || 'audio/wav',
    sourceDuration: audio.duration || p.duration,
    offsetIntoSource: 0,
    durationSec: audio.duration || p.duration,
    startSec: 0,
    color: '#8b5cf6',
    sourceKind: 'audio',
  });
};
```

**Step 2: Commit**

```bash
git add frontend/src/views/AdvancedGenPanel.tsx
git commit -m "feat: send generated audio to DAW waveform editor as new layer"
```

---

### Task 7: Wire Send-to-Editor

**Files:**
- Modify: `frontend/src/views/AdvancedGenPanel.tsx` — Output card "→ Editor" button
- Create: `frontend/src/state/advancedEditorStore.ts` — shared state for the editor panel's source file

**Step 1: Create shared editor source store**

```typescript
import { create } from 'zustand';

interface AdvancedEditorSourceState {
  sourceFile: File | null;
  setSource: (file: File | null) => void;
}

export const useAdvancedEditorSourceStore = create<AdvancedEditorSourceState>()((set) => ({
  sourceFile: null,
  setSource: (sourceFile) => set({ sourceFile }),
}));
```

**Step 2: Wire the button in AdvancedGenPanel**

```typescript
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';

const setEditorSource = useAdvancedEditorSourceStore((s) => s.setSource);

const handleSendToEditor = async () => {
  if (!lastAudioUrl) return;
  const res = await fetch(lastAudioUrl);
  const blob = await res.blob();
  setEditorSource(new File([blob], lastFilename || 'output.wav', { type: blob.type }));
};
```

**Step 3: Commit**

```bash
git add frontend/src/state/advancedEditorStore.ts frontend/src/views/AdvancedGenPanel.tsx
git commit -m "feat: send-to-editor bridge between gen panel and editor panel"
```

---

## Summary

| Task | What | New Files | Modified Files |
|------|------|-----------|----------------|
| 1 | Prompt Library Store | `promptLibraryStore.ts` | — |
| 2 | Effect Chain Store | `effectChainStore.ts` | — |
| 3 | Compact Gen Panel | `AdvancedGenPanel.tsx` | — |
| 4 | Editor Panel | `AdvancedEditorPanel.tsx` | — |
| 5 | Split Layout | — | `AdvancedView.tsx` |
| 6 | Send to DAW | — | `AdvancedGenPanel.tsx` |
| 7 | Send to Editor | `advancedEditorStore.ts` | `AdvancedGenPanel.tsx` |

Total: 5 new files, 2 modified files. Zero backend changes (all 24 effects already implemented).
