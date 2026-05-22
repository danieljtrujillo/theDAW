# Plan: Inpaint Region in Waveform Editor

**Goal:** Let the user drag-select a time range on a clip in the Waveform Editor, then trigger inpaint via right-click → "Inpaint Region" or Ctrl+P. The selected region is dispatched to the generate pipeline as the inpaint source.

---

## How It Should Feel

1. User hovers over the waveform body of a clip — cursor changes to `crosshair`.
2. User click-drags horizontally → a semi-transparent purple overlay grows over the selected time range on that clip.
3. Right-clicking anywhere on the overlay (or on the clip while selection is active) shows the existing context menu with a new item: **"Inpaint Region (Ctrl+P)"**.
4. Pressing Ctrl+P while a selection exists does the same thing.
5. Inpaint is dispatched: sets `inpaintAudioFile`, `maskStart`, `maskEnd`, `inpaintEnabled` in `generateParamsStore`, then switches to the Create tab.
6. Pressing Escape clears the selection.

---

## Architecture Decisions

### Selection lives in `editorStore` (not local state)
Other parts of the UI (context menu, hotkey handler, inpaint dispatcher) all need to read it. A store field is the right call.

### Drag gesture: clip body only, no modifier key needed
The existing clip drag-to-move gesture fires from `onPointerDown` on the **clip header bar** (the narrow top strip with the label). The waveform peak area below that has no pointer handler yet. Inpaint drag fires from that waveform body area. No modifier key needed — the two gestures live in separate DOM regions.

### Single-clip inpainting for V1
The selection is anchored to one clip. Multi-clip region mixing can be V2.

### mask coordinates are in source-file time, not timeline time
`inpaintAudioFile` = the full `audioBlob` of the clip (the raw source).  
`maskStart` / `maskEnd` must be offset by `clip.offsetIntoSource` so they map correctly into the audio file the backend receives.

---

## Files Touched

| File | Change |
|------|--------|
| `frontend/src/state/editorStore.ts` | Add `inpaintSelection` field + `setInpaintSelection` / `clearInpaintSelection` |
| `frontend/src/components/audio/WaveformEditor.tsx` | Drag gesture on clip body; render overlay; extend keyboard handler; context menu item; Ctrl+P dispatcher |
| `frontend/src/views/StudioView.tsx` | Thread `onSwitchTab` prop down to WaveformEditor |
| `frontend/src/components/layout/Shell.tsx` | Pass `onSwitchTab` into StudioView |
| `frontend/src/state/generateParamsStore.ts` | No changes needed — `patch` already exists |

No new files required.

---

## Phase 1 — `editorStore` Selection State

Add to `editorStore.ts`:

```ts
// New type
export interface InpaintSelection {
  clipId: string;
  startSec: number; // timeline seconds
  endSec: number;   // timeline seconds
}

// In EditorState interface
inpaintSelection: InpaintSelection | null;

// In store actions
setInpaintSelection: (sel: InpaintSelection | null) => void;
clearInpaintSelection: () => void;
```

Implementation:

```ts
inpaintSelection: null,
setInpaintSelection: (sel) => set({ inpaintSelection: sel }),
clearInpaintSelection: () => set({ inpaintSelection: null }),
```

---

## Phase 2 — Drag Gesture on Clip Body

### DOM structure change in `WaveformEditor.tsx`

Currently the clip div has:
- A narrow header bar (`<div className="... h-[14px]">`) — used for label/color. **14px tall.**
- The peaks flex area fills the rest.

The header bar already captures pointer events for the move drag. The peaks area needs a new pointer handler for inpaint selection.

Add a transparent overlay **inside the clip div, below the header**:

```tsx
{/* Inpaint drag target — sits over the waveform peaks area */}
<div
  className="absolute inset-x-0 bottom-0 cursor-crosshair z-10"
  style={{ top: 14 }}
  onPointerDown={(e) => handleInpaintDragStart(e, clip)}
  onPointerMove={(e) => handleInpaintDragMove(e)}
  onPointerUp={() => handleInpaintDragEnd()}
/>
```

### `handleInpaintDragStart`

```ts
const inpaintDragRef = useRef<{
  clipId: string;
  anchorSec: number;
} | null>(null);

function handleInpaintDragStart(e: React.PointerEvent, clip: AudioClip) {
  e.stopPropagation(); // prevent clip root onPointerDown from also firing
  e.currentTarget.setPointerCapture(e.pointerId);

  const rect = timelineRef.current!.getBoundingClientRect();
  const clickSec = pxToSec(e.clientX - rect.left + timelineRef.current!.scrollLeft);

  inpaintDragRef.current = { clipId: clip.id, anchorSec: clickSec };
  // Don't set selection yet — wait for meaningful movement in onPointerMove
  // to avoid flashing an overlay on accidental clicks.
}
```

```ts
function handleInpaintDragMove(e: React.PointerEvent) {
  if (!inpaintDragRef.current) return;
  const rect = timelineRef.current!.getBoundingClientRect();
  const curSec = pxToSec(e.clientX - rect.left + timelineRef.current!.scrollLeft);
  const { clipId, anchorSec } = inpaintDragRef.current;

  const clip = clips.find(c => c.id === clipId)!;
  const clampedStart = Math.max(clip.startSec, Math.min(anchorSec, curSec));
  const clampedEnd   = Math.min(clip.startSec + clip.durationSec, Math.max(anchorSec, curSec));

  // Only show the overlay once the drag is wide enough to be intentional.
  if (clampedEnd - clampedStart >= 0.1) {
    setInpaintSelection({ clipId, startSec: clampedStart, endSec: clampedEnd });
  }
}

function handleInpaintDragEnd() {
  const sel = useEditorStore.getState().inpaintSelection;
  if (!sel || sel.endSec - sel.startSec < 0.1) {
    clearInpaintSelection();
  }
  inpaintDragRef.current = null;
  // selection stays until Escape or new drag
}
```

> **Note:** `pxToSec` is the existing `useCallback((px) => px / zoom, [zoom])` helper at `WaveformEditor.tsx:357`. Use it rather than open-coding `/ zoom`. `timelineRef.current!.scrollLeft` is the DOM scroll position in pixels — it is **not** the same as `scrollSec` (which is seconds) from the store.

---

## Phase 3 — Render the Selection Overlay

Inside the clip div, render the overlay **above** the waveform bars (high z-index) when the selection matches this clip:

```tsx
{inpaintSelection?.clipId === clip.id && (
  <div
    className="absolute top-0 bottom-0 pointer-events-none z-20 border-x border-purple-400"
    style={{
      left:  (inpaintSelection.startSec - clip.startSec) * zoom,
      width: (inpaintSelection.endSec - inpaintSelection.startSec) * zoom,
      background: 'rgba(168, 85, 247, 0.18)',
    }}
  >
    {/* Duration label inside the overlay so it doesn't clip outside the clip div */}
    <span className="absolute top-0.5 left-1 text-[8px] font-mono text-purple-300 pointer-events-none leading-none">
      {(inpaintSelection.endSec - inpaintSelection.startSec).toFixed(2)}s
    </span>
  </div>
)}
```

> **Note:** The label is placed **inside** the overlay div (not at `-top-4`) to avoid being clipped by `overflow-hidden` on the clip div when the clip sits in the top track row.

---

## Phase 4 — Context Menu Item

The existing right-click menu (`ctxMenu` state) is a **fixed-position overlay rendered outside the clip loop** (around line 811). Inside that overlay, the clip is retrieved via `clips.find((c) => c.id === ctxMenu.clipId)`. Extend it with:

```tsx
{/* In the existing context menu JSX, add at the top — use ctxMenu.clipId, not clip.id */}
{inpaintSelection?.clipId === ctxMenu.clipId && (
  <>
    <button
      className="w-full text-left px-3 py-1 hover:bg-purple-500/15 text-purple-300 flex items-center justify-between"
      onClick={() => { setCtxMenu(null); dispatchInpaint(); }}
    >
      <span>Inpaint Region</span>
      <span className="text-zinc-600 text-[8px]">Ctrl P</span>
    </button>
    <div className="border-t border-white/5 my-1" />
  </>
)}
```

---

## Phase 5 — Keyboard Handler (Ctrl+P)

In the existing `useEffect` that registers `keydown`:

```ts
if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
  e.preventDefault();
  const sel = useEditorStore.getState().inpaintSelection;
  if (sel) dispatchInpaint();
  return;
}

if (e.key === 'Escape') {
  clearInpaintSelection();
  // existing escape handling...
}
```

---

## Phase 6 — `dispatchInpaint`

This function lives as a local function in `WaveformEditor.tsx`. Read state directly from the store rather than relying on default-argument tricks:

```ts
function dispatchInpaint() {
  const sel = useEditorStore.getState().inpaintSelection;
  if (!sel) return;

  const clip = useEditorStore.getState().clips.find(c => c.id === sel.clipId);
  if (!clip) return;

  // Convert timeline seconds → source-file seconds
  const maskStart = (sel.startSec - clip.startSec) + clip.offsetIntoSource;
  const maskEnd   = (sel.endSec   - clip.startSec) + clip.offsetIntoSource;

  const file = new File([clip.audioBlob], clip.label || 'inpaint-source', {
    type: clip.mimeType || 'audio/wav',
  });

  useGenerateParamsStore.getState().patch({
    inpaintAudioFile: file,
    inpaintEnabled:   true,
    maskStart,
    maskEnd,
  });

  // Switch to Create tab so user sees the inpaint panel
  onSwitchTab?.('create');
}
```

---

## Prop Threading for `onSwitchTab`

`activeView` is local `useState` in `Shell.tsx` — it is **not** in a store, so `WaveformEditor` cannot access it directly. The threading chain is:

```
Shell.tsx        (owns activeView + setActiveView)
  └── StudioView.tsx   ← add prop: onSwitchTab?: (tab: string) => void
        └── WaveformEditor.tsx  ← add prop: onSwitchTab?: (tab: string) => void
```

In `Shell.tsx`, where `StudioView` is rendered:
```tsx
{activeView === 'edit' && <StudioView onSwitchTab={(tab) => setActiveView(tab)} />}
```

> **Do NOT route through `DAWCenterPanel`.** `DAWCenterPanel` controls the bottom panel tabs (`spectral | details | piano-roll | bucket`) — it has no role in switching the main left-panel view.

---

## Edge Cases to Handle

| Case | Handling |
|------|----------|
| Selection is < ~100ms (accidental click) | Overlay never appears during drag (guarded in `handleInpaintDragMove`); cleared in `handleInpaintDragEnd` |
| User starts a new drag while a selection exists | `handleInpaintDragStart` overwrites with new anchor; `handleInpaintDragMove` overwrites selection |
| User clicks anywhere on the timeline (not a clip) | Add `onClick` on the timeline background to `clearInpaintSelection()` |
| Clip is trimmed (`offsetIntoSource > 0`) | Already handled — `dispatchInpaint` adds the offset before patching `maskStart/maskEnd` |
| User right-clicks on the clip but no selection | Existing context menu appears unchanged — no inpaint item |
| Clip is piano-roll sourced | Inpaint still works — `audioBlob` is the rendered WAV |

---

## What This Does NOT Do (V2+)

- **Auto-replace after generation**: After generate completes, splice the returned audio back into the clip at the selection range. Requires listening for generate completion and knowing which clip/range it targets.
- **Multi-clip inpainting**: Mix overlapping clips in the selection range into one source file before dispatching.
- **Visual feedback during generation**: Show a "generating..." state on the clip region while the backend works.

---

## Implementation Order

1. `editorStore.ts` — add `inpaintSelection`, `setInpaintSelection`, `clearInpaintSelection`
2. `WaveformEditor.tsx` — add `inpaintDragRef`, `handleInpaintDragStart/Move/End`, render overlay
3. `WaveformEditor.tsx` — add Escape clears selection, existing `onContextMenu` skips when dragging
4. `WaveformEditor.tsx` — add context menu item for inpaint (using `ctxMenu.clipId`, not `clip.id`)
5. `WaveformEditor.tsx` — add Ctrl+P handler + `dispatchInpaint` function
6. Thread `onSwitchTab` prop: `Shell → StudioView → WaveformEditor`
7. Manual test: drag a region, right-click → inpaint, check generateParamsStore values
