/**
 * Assistant references — the explicit "act on THIS" list the user hands
 * gantasmob0t before sending a message.
 *
 * Without it the model has to guess which clip "the loud one" is and picks by
 * name, which is how it ends up editing the wrong take. A reference is an ID
 * plus a display label: the id is authoritative, the label is only ever shown
 * to a human. A reference never carries bytes, a Blob/object URL, or a
 * filesystem path — the assistant transport must stay free of user media.
 *
 * Units: every `*Sec` value is timeline seconds (not samples, not CSS px).
 *
 * `resolve()` re-checks a reference against the live document every time it is
 * rendered or sent, so a clip that was deleted or moved is reported as such
 * instead of being silently re-aimed at whatever happens to be selected now.
 */
import { create } from 'zustand';

import { useEditorStore, type EditorTimeRange } from './editorStore';
import { useLibraryStore } from './libraryStore';
import { useProjectStore } from './projectStore';

/** A clip the user pointed at. `assetId` is the Library entry it came from. */
export interface ClipReference {
  kind: 'clip';
  /** The project the reference was taken in (its name; never a path). */
  projectId: string | null;
  clipId: string;
  trackId: string;
  assetId: string | null;
  label: string;
  /** Epoch ms the chip was created. */
  addedAt: number;
}

/** A span of the arrangement: `[startSec, endSec)`, over every track or a list. */
export interface TimeRangeReference {
  kind: 'time-range';
  startSec: number;
  endSec: number;
  trackIds: string[] | 'all';
  label: string;
}

export interface LibraryAssetReference {
  kind: 'library-asset';
  entryId: string;
  label: string;
}

export interface TrackReference {
  kind: 'track';
  trackId: string;
  label: string;
}

export type AssistantReference =
  | ClipReference
  | TimeRangeReference
  | LibraryAssetReference
  | TrackReference;

export type ReferenceStatus = 'ok' | 'missing' | 'changed';

export interface ResolvedReference {
  status: ReferenceStatus;
  /** One human-readable line: what the reference points at, or why it cannot. */
  detail: string;
}

/**
 * One entry of the `references` array in the app-context payload: the
 * reference as the user made it, resolved against the document, plus the
 * current facts of whatever it points at. A `missing` entry carries the id the
 * user named but no facts — there is nothing truthful to say about it.
 */
export interface AssistantReferenceContext {
  kind: AssistantReference['kind'];
  label: string;
  status: ReferenceStatus;
  detail: string;
  /** The id the user pointed at — present even when the target is gone. */
  clipId?: string;
  entryId?: string;
  trackId?: string;
  clip?: {
    id: string;
    trackId: string;
    startSec: number;
    durationSec: number;
    gain: number;
    muted: boolean;
  };
  range?: { startSec: number; endSec: number; trackIds: string[] | 'all' };
  asset?: { entryId: string; title: string };
  track?: { id: string; name: string };
}

/** Window event `requestAssistantFocus()` fires; the orb panel listens for it. */
export const ASSISTANT_FOCUS_EVENT = 'thedaw:assistant-focus';

const round2 = (n: number): number => Math.round(n * 100) / 100;

const sec = (n: number): string => `${n.toFixed(2)}s`;

/**
 * Stable identity of a reference — what `add()` dedupes on, what `remove()`
 * takes, and what the chip list keys on. Two ranges with the same bounds over
 * the same tracks are the same reference whatever order the ids arrived in.
 */
export function referenceKey(ref: AssistantReference): string {
  switch (ref.kind) {
    case 'clip':
      return `clip:${ref.clipId}`;
    case 'library-asset':
      return `asset:${ref.entryId}`;
    case 'track':
      return `track:${ref.trackId}`;
    case 'time-range': {
      const scope = ref.trackIds === 'all' ? 'all' : [...ref.trackIds].sort().join(',');
      return `range:${ref.startSec}:${ref.endSec}:${scope}`;
    }
  }
}

/** Reject a span that cannot be acted on before it ever becomes a chip. */
function assertRange(ref: TimeRangeReference): void {
  if (!Number.isFinite(ref.startSec) || !Number.isFinite(ref.endSec)) {
    throw new RangeError('time-range reference needs finite startSec and endSec (timeline seconds)');
  }
  if (ref.endSec <= ref.startSec) {
    throw new RangeError(`time-range reference needs endSec > startSec (got ${ref.startSec}, ${ref.endSec})`);
  }
}

// ── Builders ───────────────────────────────────────────────────────────────

/** A reference to a clip that exists right now, or null when the id is unknown. */
export function referenceForClip(clipId: string): ClipReference | null {
  const clip = useEditorStore.getState().clips.find((c) => c.id === clipId);
  if (!clip) return null;
  return {
    kind: 'clip',
    projectId: useProjectStore.getState().projectName || null,
    clipId: clip.id,
    trackId: clip.trackId,
    assetId: clip.libraryEntryId ?? null,
    label: clip.label,
    addedAt: Date.now(),
  };
}

/** A reference to the editor's current time selection, or null when there is none. */
export function referenceForTimeSelection(): TimeRangeReference | null {
  const range: EditorTimeRange | null = useEditorStore.getState().timeSelection;
  if (!range) return null;
  const trackIds: string[] | 'all' = range.scope.kind === 'all-tracks' ? 'all' : [...range.scope.ids];
  const scopeLabel = trackIds === 'all'
    ? 'all tracks'
    : `${trackIds.length} track${trackIds.length === 1 ? '' : 's'}`;
  const ref: TimeRangeReference = {
    kind: 'time-range',
    startSec: range.startSec,
    endSec: range.endSec,
    trackIds,
    label: `${sec(range.startSec)}–${sec(range.endSec)} (${scopeLabel})`,
  };
  assertRange(ref);
  return ref;
}

/** A reference to a Library entry that exists right now, or null. */
export function referenceForLibraryEntry(entryId: string): LibraryAssetReference | null {
  const entry = useLibraryStore.getState().entries.find((e) => e.id === entryId);
  if (!entry) return null;
  return { kind: 'library-asset', entryId: entry.id, label: entry.title };
}

/** A reference to a track that exists right now, or null. */
export function referenceForTrack(trackId: string): TrackReference | null {
  const track = useEditorStore.getState().tracks.find((t) => t.id === trackId);
  if (!track) return null;
  return { kind: 'track', trackId: track.id, label: track.name };
}

/**
 * Ask the orb panel to open/focus its composer so the user can type against
 * the chips they just added. Deliberately does NOT send anything — adding a
 * reference is not a request. No-op outside a browser.
 */
export function requestAssistantFocus(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ASSISTANT_FOCUS_EVENT));
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** Re-check a reference against the live editor / library state. */
export function resolveAssistantReference(ref: AssistantReference): ResolvedReference {
  const editor = useEditorStore.getState();

  switch (ref.kind) {
    case 'clip': {
      const clip = editor.clips.find((c) => c.id === ref.clipId);
      if (!clip) {
        return { status: 'missing', detail: `Clip "${ref.label}" (${ref.clipId}) is no longer in the project` };
      }
      const drift: string[] = [];
      if (clip.trackId !== ref.trackId) {
        const track = editor.tracks.find((t) => t.id === clip.trackId);
        drift.push(`moved to ${track?.name ?? clip.trackId}`);
      }
      if (clip.label !== ref.label) drift.push(`renamed to "${clip.label}"`);
      if ((clip.libraryEntryId ?? null) !== ref.assetId) drift.push('now points at a different library asset');
      if (drift.length) return { status: 'changed', detail: `Clip ${ref.clipId}: ${drift.join(', ')}` };
      const track = editor.tracks.find((t) => t.id === clip.trackId);
      return { status: 'ok', detail: `Clip "${clip.label}" on ${track?.name ?? clip.trackId}` };
    }

    case 'time-range': {
      if (ref.trackIds === 'all') {
        return { status: 'ok', detail: `${sec(ref.startSec)}–${sec(ref.endSec)} across all tracks` };
      }
      const known = new Set(editor.tracks.map((t) => t.id));
      const gone = ref.trackIds.filter((id) => !known.has(id));
      if (gone.length === ref.trackIds.length) {
        return {
          status: 'missing',
          detail: `${sec(ref.startSec)}–${sec(ref.endSec)}: none of its tracks are in the project any more (${gone.join(', ')})`,
        };
      }
      if (gone.length) {
        return {
          status: 'changed',
          detail: `${sec(ref.startSec)}–${sec(ref.endSec)}: ${gone.join(', ')} no longer in the project`,
        };
      }
      return { status: 'ok', detail: `${sec(ref.startSec)}–${sec(ref.endSec)} on ${ref.trackIds.join(', ')}` };
    }

    case 'library-asset': {
      const entry = useLibraryStore.getState().entries.find((e) => e.id === ref.entryId);
      if (!entry) return { status: 'missing', detail: `Library entry ${ref.entryId} ("${ref.label}") is gone` };
      if (entry.title !== ref.label) {
        return { status: 'changed', detail: `Library entry ${ref.entryId} is now titled "${entry.title}"` };
      }
      return { status: 'ok', detail: `Library entry "${entry.title}"` };
    }

    case 'track': {
      const track = editor.tracks.find((t) => t.id === ref.trackId);
      if (!track) return { status: 'missing', detail: `Track ${ref.trackId} ("${ref.label}") is no longer in the project` };
      if (track.name !== ref.label) {
        return { status: 'changed', detail: `Track ${ref.trackId} is now named "${track.name}"` };
      }
      return { status: 'ok', detail: `Track "${track.name}"` };
    }
  }
}

/** The resolved, fact-carrying form sent inside `<current_app_context>`. */
export function referenceContextEntry(ref: AssistantReference): AssistantReferenceContext {
  const resolved = resolveAssistantReference(ref);
  const base = { kind: ref.kind, label: ref.label, status: resolved.status, detail: resolved.detail };
  const editor = useEditorStore.getState();

  switch (ref.kind) {
    case 'clip': {
      const clip = editor.clips.find((c) => c.id === ref.clipId);
      return {
        ...base,
        clipId: ref.clipId,
        ...(clip
          ? {
            clip: {
              id: clip.id,
              trackId: clip.trackId,
              startSec: round2(clip.startSec),
              durationSec: round2(clip.durationSec),
              gain: clip.gain ?? 1,
              muted: !!clip.muted,
            },
          }
          : {}),
      };
    }
    case 'time-range':
      return {
        ...base,
        range: {
          startSec: round2(ref.startSec),
          endSec: round2(ref.endSec),
          trackIds: ref.trackIds === 'all' ? 'all' : [...ref.trackIds],
        },
      };
    case 'library-asset': {
      const entry = useLibraryStore.getState().entries.find((e) => e.id === ref.entryId);
      return {
        ...base,
        entryId: ref.entryId,
        ...(entry ? { asset: { entryId: entry.id, title: entry.title } } : {}),
      };
    }
    case 'track': {
      const track = editor.tracks.find((t) => t.id === ref.trackId);
      return {
        ...base,
        trackId: ref.trackId,
        ...(track ? { track: { id: track.id, name: track.name } } : {}),
      };
    }
  }
}

// ── Store ──────────────────────────────────────────────────────────────────

export interface AssistantReferenceState {
  /** The chips beside the composer, in the order the user added them. */
  references: AssistantReference[];
  /** Add a reference; adding one that is already listed is a no-op. */
  add: (ref: AssistantReference) => void;
  /** Drop one chip by its `referenceKey`. Unknown keys are ignored. */
  remove: (key: string) => void;
  /** Drop every chip (what send does once the message is on its way). */
  clear: () => void;
  resolve: (ref: AssistantReference) => ResolvedReference;
}

export const useAssistantReferenceStore = create<AssistantReferenceState>()((set, get) => ({
  references: [],

  add: (ref) => {
    if (ref.kind === 'time-range') assertRange(ref);
    const key = referenceKey(ref);
    if (get().references.some((r) => referenceKey(r) === key)) return;
    set((s) => ({ references: [...s.references, ref] }));
  },

  remove: (key) => set((s) => {
    const next = s.references.filter((r) => referenceKey(r) !== key);
    return next.length === s.references.length ? s : { references: next };
  }),

  clear: () => set((s) => (s.references.length ? { references: [] } : s)),

  resolve: (ref) => resolveAssistantReference(ref),
}));
