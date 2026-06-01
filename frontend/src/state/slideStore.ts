/**
 * SLIDE tab state.
 *
 * Holds the control surface's UI state (which catalog, which view, which page,
 * which device profile), the per-slot assignments (manual lock / drag-reorder
 * overrides on top of auto-fill), and the live control values.
 *
 * Phase 1 is visuals-first: values live here as local state. Phase 2 will
 * bridge `setValue` / `setOn` to a control-sync bus + the VJ iframe so a
 * SLIDE slider and its mapped VJ/effect/audio control move together.
 *
 * Slot resolution (which catalog item shows at slot N):
 *   1. a LOCKED assignment pins an item to a slot (auto-fill skips it),
 *   2. a drag-reorder writes explicit (unlocked) assignments for both slots,
 *   3. otherwise the slot auto-fills from catalog[N].
 * `resolveItem` implements that precedence; the catalog is supplied by the
 * caller (VISUAL ← effects/plugins, AUDIO ← interfaces/stems/tracks).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PROFILE_ID } from './controllerProfiles';

export type SlideContent = 'audio' | 'visual';
export type SlideView = 'row' | 'focus' | 'controller';

/**
 * A control the VJ app exposes for two-way sync. Mirrors the VJ side's
 * controlManifest entry — described in NATIVE units; the control-sync bus
 * converts to/from the SLIDE 0..100 fader scale. Empty until the VJ iframe
 * connects and answers `request-controls`.
 */
export interface VisualControl {
  key: string;
  label: string;
  kind: 'range' | 'toggle';
  group: string;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * What flips pages (banks), beyond the always-on ←/→ keyboard shortcut. The
 * hardware options bind in Phase 2 when a controller is connected — e.g. the
 * AKAI's bank buttons, or a chosen Track-Select / Send-Select control.
 */
export type PageNavBinding = 'keys' | 'track-select' | 'send-select' | 'none';

/**
 * A custom "stack" lane (2C): one SLIDE slider the user binds to a media item
 * (image/video/audio) AND one or more VJ effect targets. Moving the slider
 * fans out 0..100 onto each target's sub-range; selecting the stack can load
 * its media into the VJ. Stacks are VISUAL-only for now (audio stacks later).
 *
 * A stack occupies a catalog slot whose label is `STACK_PREFIX + id` so it
 * never collides with a real control name; the lane shows `stack.name`.
 */
export const STACK_PREFIX = 'stack:';

export interface StackTarget {
  /** VJ manifest control key the slider drives. */
  key: string;
  /** Lane 0..100 maps onto [fromPct..toPct] of THIS target (defaults 0..100),
   *  so one slider can push BLOOM 0..100 while GLITCH only rides 0..40. */
  fromPct?: number;
  toPct?: number;
}

export interface StackMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  label: string;
  entryId?: string;
}

export interface StackBinding {
  id: string;
  name: string;
  media?: StackMedia | null;
  targets: StackTarget[];
}

/** True if a catalog label is a stack sentinel; returns the stack id. */
export function stackIdFromLabel(label: string | null): string | null {
  return label && label.startsWith(STACK_PREFIX) ? label.slice(STACK_PREFIX.length) : null;
}

export interface SlotAssignment {
  /** Catalog item pinned/placed at this slot, or null to leave it open. */
  item: string | null;
  /** Locked slots are never overwritten by auto-fill. */
  locked: boolean;
}

type AssignMap = Record<number, SlotAssignment>;

interface SlideState {
  content: SlideContent;
  view: SlideView;
  profileId: string;
  /** Auto-detect the profile from the connected MIDI device name. When false
   *  the user's manual `profileId` choice is respected. */
  autoDetect: boolean;
  /** Current page (bank) per content — paging is independent for AUDIO/VISUAL. */
  bank: Record<SlideContent, number>;
  /** Hardware control that also flips pages (← / → keys always work). */
  pageNavBinding: PageNavBinding;
  /** Per-content slot overrides (lock / drag-reorder). */
  assignments: Record<SlideContent, AssignMap>;
  /** Live values keyed `${content}/${item}` (0..100). */
  values: Record<string, number>;
  /** Pad on/off keyed `${content}/${item}`. */
  pads: Record<string, boolean>;
  /** Control manifest from the connected VJ app (drives the VISUAL catalog).
   *  Empty until the iframe connects. NOT persisted — re-fetched each session. */
  visualControls: VisualControl[];
  /** User-defined stack lanes (2C). Persisted. VISUAL-only for now. */
  stacks: StackBinding[];

  setContent: (c: SlideContent) => void;
  setView: (v: SlideView) => void;
  setProfileId: (id: string) => void;
  setAutoDetect: (on: boolean) => void;
  setBank: (b: number) => void;
  setPageNavBinding: (b: PageNavBinding) => void;
  toggleLock: (index: number, fallbackItem: string | null) => void;
  /** Swap the items (and lock state) of two slots — drag reorder. */
  swapSlots: (a: number, b: number, itemA: string | null, itemB: string | null) => void;
  setValue: (item: string, value: number) => void;
  setOn: (item: string, on: boolean) => void;
  /** Content-explicit writes — used by the control-sync bus to apply inbound
   *  VJ changes into the VISUAL namespace regardless of which tab is active. */
  setValueFor: (content: SlideContent, item: string, value: number) => void;
  setOnFor: (content: SlideContent, item: string, on: boolean) => void;
  setVisualControls: (controls: VisualControl[]) => void;
  /** Stack CRUD. addStack returns the new stack's id. */
  addStack: (init?: Partial<StackBinding>) => string;
  updateStack: (id: string, updates: Partial<StackBinding>) => void;
  removeStack: (id: string) => void;
  resetAssignments: () => void;
}

const stackUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `stk-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const emptyAssign = (): Record<SlideContent, AssignMap> => ({ audio: {}, visual: {} });

export const useSlideStore = create<SlideState>()(
  persist(
    (set) => ({
      content: 'visual',
      view: 'row',
      profileId: DEFAULT_PROFILE_ID,
      autoDetect: true,
      bank: { audio: 0, visual: 0 },
      pageNavBinding: 'keys',
      assignments: emptyAssign(),
      values: {},
      pads: {},
      visualControls: [],
      stacks: [],

      setContent: (content) => set({ content }),
      setView: (view) => set({ view }),
      setProfileId: (profileId) => set({ profileId }),
      setAutoDetect: (autoDetect) => set({ autoDetect }),
      setBank: (b) =>
        set((s) => ({ bank: { ...s.bank, [s.content]: Math.max(0, b) } })),

      setPageNavBinding: (pageNavBinding) => set({ pageNavBinding }),

      toggleLock: (index, fallbackItem) =>
        set((s) => {
          const map = { ...s.assignments[s.content] };
          const cur = map[index];
          if (cur && cur.locked) {
            delete map[index];
          } else {
            map[index] = { item: cur?.item ?? fallbackItem, locked: true };
          }
          return { assignments: { ...s.assignments, [s.content]: map } };
        }),

      swapSlots: (a, b, itemA, itemB) =>
        set((s) => {
          const map = { ...s.assignments[s.content] };
          const ea = map[a] ?? { item: itemA, locked: false };
          const eb = map[b] ?? { item: itemB, locked: false };
          map[a] = { item: eb.item, locked: eb.locked };
          map[b] = { item: ea.item, locked: ea.locked };
          return { assignments: { ...s.assignments, [s.content]: map } };
        }),

      setValue: (item, value) =>
        set((s) => ({
          values: { ...s.values, [`${s.content}/${item}`]: Math.max(0, Math.min(100, value)) },
        })),

      setOn: (item, on) =>
        set((s) => ({ pads: { ...s.pads, [`${s.content}/${item}`]: on } })),

      setValueFor: (content, item, value) =>
        set((s) => ({
          values: { ...s.values, [`${content}/${item}`]: Math.max(0, Math.min(100, value)) },
        })),

      setOnFor: (content, item, on) =>
        set((s) => ({ pads: { ...s.pads, [`${content}/${item}`]: on } })),

      setVisualControls: (visualControls) => set({ visualControls }),

      addStack: (init) => {
        const id = init?.id ?? stackUid();
        const stack: StackBinding = {
          id,
          name: init?.name ?? 'STACK',
          media: init?.media ?? null,
          targets: init?.targets ?? [],
        };
        set((s) => ({ stacks: [...s.stacks, stack] }));
        return id;
      },

      updateStack: (id, updates) =>
        set((s) => ({
          stacks: s.stacks.map((st) => (st.id === id ? { ...st, ...updates } : st)),
        })),

      removeStack: (id) =>
        set((s) => ({ stacks: s.stacks.filter((st) => st.id !== id) })),

      resetAssignments: () => set({ assignments: emptyAssign() }),
    }),
    {
      name: 'stabledaw-slide-v1',
      partialize: (s) => ({
        content: s.content,
        view: s.view,
        profileId: s.profileId,
        autoDetect: s.autoDetect,
        bank: s.bank,
        pageNavBinding: s.pageNavBinding,
        assignments: s.assignments,
        values: s.values,
        pads: s.pads,
        stacks: s.stacks,
      }),
    },
  ),
);

/**
 * Resolve which catalog item shows at a global slot index, honoring the
 * lock/drag precedence above. Pure — pass the active content's assignment map
 * and the catalog. Returns null for an open (auto-fill-pending) slot.
 */
export function resolveItem(
  assignments: AssignMap,
  catalog: readonly string[],
  index: number,
): string | null {
  const a = assignments[index];
  if (a) return a.item; // explicit placement (locked OR drag-moved)
  return index < catalog.length ? catalog[index] : null;
}

export function isSlotLocked(assignments: AssignMap, index: number): boolean {
  return !!assignments[index]?.locked;
}

/** Read a live value (default seeded elsewhere) for `${content}/${item}`. */
export function valueKey(content: SlideContent, item: string): string {
  return `${content}/${item}`;
}
