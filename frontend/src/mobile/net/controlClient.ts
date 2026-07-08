/**
 * Controller-role client for the companion control bus (mobile side).
 *
 * The phone is a CONTROLLER peer: it opens the same `/api/xr/control/ws` relay
 * the desktop host publishes to, presents the pairing code (when the host
 * requires one), renders widgets from the host's manifest, and sends
 * `control-set` frames. See docs/companion-control-contract.md.
 *
 * This is deliberately NOT the desktop's xrControlClient (that one is the host,
 * publishes a manifest, and applies inbound sets). Here the roles are inverted.
 */
import { create } from 'zustand';

// Strings carry `select` option choices and `text` field contents; knobs and
// faders stay numeric, toggles/buttons boolean. Matches the host's
// XrControlValue in state/xrControlClient.ts.
export type ControlValue = number | boolean | string;

export interface ManifestEntry {
  id: string;
  area: string;
  group: string;
  label: string;
  kind: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
  value?: ControlValue;
  readonly?: boolean;
}

export type ControlStatus = 'connecting' | 'paired' | 'rejected' | 'offline';

interface ControlState {
  status: ControlStatus;
  entries: ManifestEntry[];
  values: Record<string, ControlValue>;
  /** Open (and keep open) the bus. Safe to call repeatedly. */
  connect: () => void;
  /** Force a fresh connect (e.g. after entering a pair code). */
  retry: () => void;
  disconnect: () => void;
  setControl: (id: string, value: ControlValue) => void;
  entriesForArea: (area: string) => ManifestEntry[];
}

function wsUrl(): string {
  const { protocol, host } = window.location;
  const scheme = protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}/api/xr/control/ws`;
}

function deviceLabel(): string {
  const ua = navigator.userAgent || '';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/android/i.test(ua)) return 'Android';
  return 'Phone';
}

function pairCode(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('pair');
  } catch {
    return null;
  }
}

let ws: WebSocket | null = null;
let running = false;
let reconnectTimer = 0;
// Set true on pair-rejected so we stop auto-reconnecting into the same wall;
// retry() clears it.
let rejected = false;

export const useControlStore = create<ControlState>((set, get) => {
  function scheduleReconnect(): void {
    if (!running || reconnectTimer || rejected) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      open();
    }, 2000);
  }

  function open(): void {
    if (!running || ws) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(wsUrl());
    } catch {
      set({ status: 'offline' });
      scheduleReconnect();
      return;
    }
    ws = sock;
    set({ status: 'connecting' });
    sock.onopen = () => {
      sock.send(
        JSON.stringify({ type: 'controller-hello', label: deviceLabel(), code: pairCode() }),
      );
    };
    sock.onmessage = (e) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const m = parsed as {
        type?: unknown;
        id?: unknown;
        value?: unknown;
        entries?: unknown;
      };
      if (typeof m.type !== 'string') return;
      if (m.type === 'pair-ok') {
        rejected = false;
        set({ status: 'paired' });
        sock.send(JSON.stringify({ type: 'request-controls' }));
      } else if (m.type === 'pair-rejected') {
        rejected = true;
        set({ status: 'rejected' });
        try {
          sock.close();
        } catch {
          /* already closing */
        }
      } else if (m.type === 'manifest' && Array.isArray(m.entries)) {
        const entries = m.entries as ManifestEntry[];
        const values: Record<string, ControlValue> = {};
        for (const en of entries) {
          if (en && typeof en.id === 'string' && en.value !== undefined) {
            values[en.id] = en.value;
          }
        }
        // The manifest is the authoritative resync (it is the only path that
        // recovers changes made while this phone was disconnected), so the
        // host's fresh values win over any stale local echo.
        set({ entries, values: { ...get().values, ...values } });
      } else if (m.type === 'control-changed' && typeof m.id === 'string') {
        set((s) => ({ values: { ...s.values, [m.id as string]: m.value as ControlValue } }));
      }
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (get().status !== 'rejected') set({ status: 'offline' });
      scheduleReconnect();
    };
  }

  return {
    status: 'connecting',
    entries: [],
    values: {},

    connect: () => {
      if (running) return;
      running = true;
      rejected = false;
      open();
    },

    retry: () => {
      rejected = false;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        ws = null;
      }
      running = true;
      open();
    },

    disconnect: () => {
      running = false;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = 0;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        ws = null;
      }
    },

    setControl: (id, value) => {
      // Optimistic local echo so the widget feels instant.
      set((s) => ({ values: { ...s.values, [id]: value } }));
      if (ws && ws.readyState === WebSocket.OPEN && get().status === 'paired') {
        ws.send(JSON.stringify({ type: 'control-set', id, value }));
      }
    },

    entriesForArea: (area) => get().entries.filter((e) => e.area === area),
  };
});
