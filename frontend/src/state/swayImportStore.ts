/**
 * Imported-controller auto-attach runtime.
 *
 * Holds the SwayBindings resolved from an imported DAW project (see
 * swayImportResolve) and, while MIDI is enabled, drives theDAW's editor targets
 * from the matching MIDI messages — so opening the project makes the Sway control
 * the same tracks/effects it did in the source DAW. Bindings are session-scoped
 * (they belong to the imported project, not the global controller setup) and are
 * applied through the editor store, so liveMixer reconciles them into the live
 * audio and the FX UI reflects the moves.
 */
import { create } from 'zustand';
import { subscribeToMidi } from './midiBus';
import { useEditorStore } from './editorStore';
import type { SwayBinding, SwayUnattached, SwayResolveResult } from '../lib/swayImportResolve';

interface SwayImportState {
  bindings: SwayBinding[];
  unattached: SwayUnattached[];
  sourceName: string;
  setResult: (r: SwayResolveResult, sourceName: string) => void;
  clear: () => void;
}

export const useSwayImportStore = create<SwayImportState>((set) => ({
  bindings: [],
  unattached: [],
  sourceName: '',
  setResult: (r, sourceName) => set({ bindings: r.bindings, unattached: r.unattached, sourceName }),
  clear: () => set({ bindings: [], unattached: [], sourceName: '' }),
}));

/** Non-React reads for panels/tests. */
export const swayImportBindingCount = (): number => useSwayImportStore.getState().bindings.length;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
// Last enable state per fxEnable binding, so a toggle fires only on threshold cross.
const enableState = new Map<string, boolean>();

function applyBinding(b: SwayBinding, val01: number): void {
  const ed = useEditorStore.getState();
  if (b.target === 'volume') {
    ed.updateTrack(b.trackId, { volume: clamp01(val01) });
    return;
  }
  if (b.target === 'pan') {
    ed.updateTrack(b.trackId, { pan: Math.max(-1, Math.min(1, val01 * 2 - 1)) });
    return;
  }
  if (b.target === 'fxEnable') {
    if (!b.entryId) return;
    const on = val01 > 0.5;
    if (enableState.get(b.entryId) === on) return;
    enableState.set(b.entryId, on);
    const entry = ed.tracks.find((t) => t.id === b.trackId)?.fxChain?.find((e) => e.id === b.entryId);
    if (entry && entry.enabled !== on) ed.toggleTrackEffect(b.trackId, b.entryId);
    return;
  }
  if (!b.entryId || !b.paramKey) return;
  const entry = ed.tracks.find((t) => t.id === b.trackId)?.fxChain?.find((e) => e.id === b.entryId);
  if (!entry) return;
  const value = b.min + clamp01(val01) * (b.max - b.min);
  ed.updateTrackEffectParams(b.trackId, b.entryId, { ...entry.params, [b.paramKey]: value });
}

let unsub: (() => void) | null = null;

/** Start driving imported bindings from the MIDI bus. Idempotent; no-ops when
 *  there are no bindings, so it is safe to leave subscribed for the session. */
export function startSwayImportDriver(): () => void {
  if (unsub) return stopSwayImportDriver;
  unsub = subscribeToMidi((msg) => {
    const bindings = useSwayImportStore.getState().bindings;
    if (!bindings.length) return;
    const data = msg.data;
    const status = data[0] ?? 0;
    const cmd = status & 0xf0;
    const ch = status & 0x0f;
    const isCc = cmd === 0xb0;
    const isNoteOn = cmd === 0x90 && (data[2] ?? 0) > 0;
    const isNoteOff = cmd === 0x80 || (cmd === 0x90 && (data[2] ?? 0) === 0);
    if (!isCc && !isNoteOn && !isNoteOff) return;
    const num = data[1] ?? 0;
    const val01 = isCc ? (data[2] ?? 0) / 127 : isNoteOn ? 1 : 0;
    for (const b of bindings) {
      if (b.isNote === isCc) continue; // note binding needs a note msg; CC needs a CC msg
      if (b.number !== num) continue;
      if (b.channel !== -1 && b.channel !== ch) continue;
      applyBinding(b, val01);
    }
  });
  return stopSwayImportDriver;
}

export function stopSwayImportDriver(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
  enableState.clear();
}
