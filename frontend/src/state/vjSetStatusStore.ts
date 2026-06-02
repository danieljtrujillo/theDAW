/**
 * vjSetStatusStore — the live status of the SET handed off to the VJ.
 *
 * Closes the "did it actually land?" gap: when DJView pushes a SET via
 * vjSetBus we mark it `sent` (count + name) here; when the VJ side ACKs with
 * `sa3-vj/set-loaded`, VJView marks it `acked`. The DJ master bar, the VJ
 * toolbar, and the footer all read this so the user sees, at a glance, that the
 * set is in the VJ — not just that a button was clicked.
 */
import { create } from 'zustand';

interface VjSetStatusState {
  /** Display name of the last set sent, or null if none this session. */
  name: string | null;
  /** Item count (sent optimistically, confirmed on ack). */
  count: number;
  /** True once the VJ side confirmed receipt. */
  acked: boolean;
  /** performance.now()-ish timestamp of the last send (for a brief flash). */
  sentAt: number | null;
  /** Mark a SET as sent (optimistic — not yet confirmed by the VJ). */
  noteSent: (name: string | null, count: number) => void;
  /** Mark the last SET confirmed by the VJ side. */
  noteAck: (count: number, name?: string | null) => void;
}

export const useVjSetStatusStore = create<VjSetStatusState>()((set) => ({
  name: null,
  count: 0,
  acked: false,
  sentAt: null,
  noteSent: (name, count) => set({ name, count, acked: false, sentAt: Date.now() }),
  noteAck: (count, name) =>
    set((s) => ({ acked: true, count, name: name ?? s.name })),
}));
