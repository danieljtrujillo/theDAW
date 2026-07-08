/**
 * XR control client (spatialization P0/P1).
 *
 * Holds a WebSocket to the backend `xrcontrol` relay (`/api/xr/control/ws`), the
 * transport between theDAW (this browser, which owns the control manifest and
 * the wired setters) and a theDAW-XR headset. This browser is the HOST peer: it
 * publishes a control manifest aggregated from registered sources and applies
 * inbound `control-set` messages by routing them to the source that owns the id.
 * A new control surfaces in XR the moment its source contributes a manifest
 * entry, with no Unity edit.
 *
 * Same-origin URL so it rides the Vite dev proxy in development and is direct in
 * production. Auto-reconnects while running.
 */
import { logInfo, logWarn } from './logStore';

// Strings carry `select` option choices and `text` field contents (e.g. the
// MAKE prompt typed on a headset keyboard); knobs/faders stay numeric and
// toggles/buttons boolean.
export type XrControlValue = number | boolean | string;

/** One self-describing control in the manifest XR consumes. Mirrors the shape
 *  theDAW's own registries already use (DJ_TARGETS, the VJ control manifest). */
export interface XrManifestEntry {
  id: string;
  area: string;
  group: string;
  label: string;
  /** knob | fader | button | toggle | crossfader | select | xy | xyz | jog | grid */
  kind: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
  /** Current value, when the source can read one (seeds the XR widget). */
  value?: XrControlValue;
  /** Input-only sources publish state but cannot be set. */
  readonly?: boolean;
}

/** A contributor of controls for one namespace (e.g. "dj", "vj", "make"). */
export interface XrControlSource {
  /** Namespace that owns this source's ids, e.g. "dj" for "dj.eqHi.A". */
  area: string;
  /** Contribute this source's manifest entries (async so it can lazy-load). */
  buildEntries: () => Promise<XrManifestEntry[]> | XrManifestEntry[];
  /** Apply an inbound control value. Returns true when the id was handled. */
  apply: (id: string, value: XrControlValue) => boolean | Promise<boolean>;
}

const sources = new Map<string, XrControlSource>();
let manifestVersion = 0;

/**
 * Register a control source (DJ, then VJ / MAKE in later phases). Bumps the
 * manifest version and re-publishes when connected. Idempotent and safe to call
 * before or after {@link startXrControl}.
 */
export function registerXrControlSource(source: XrControlSource): void {
  sources.set(source.area, source);
  manifestVersion += 1;
  void publishManifest();
}

let ws: WebSocket | null = null;
let reconnectTimer = 0;
let running = false;
let everConnected = false;

function wsUrl(): string {
  const { protocol, host } = window.location;
  if (protocol === 'https:') {
    // Hosted over TLS: same-origin so the deployment's proxy carries it.
    return `wss://${host}/api/xr/control/ws`;
  }
  if (protocol === 'http:' && host) {
    // Served over http from the LAN origin (desktop web dev on
    // localhost:5173, or a phone/companion on <lan-ip>:5173 in dev /
    // <lan-ip>:8600 packaged). Derive from the origin so a phone connects to
    // its host, not to itself; the Vite proxy carries the upgrade in dev
    // (server.proxy['/api'].ws = true) and it is direct in packaged/Docker.
    return `ws://${host}/api/xr/control/ws`;
  }
  // Desktop app:// renderer — its protocol handler proxies HTTP /api/* but
  // cannot upgrade WebSockets, and the backend is always local on :8600.
  return 'ws://localhost:8600/api/xr/control/ws';
}

async function buildManifest(): Promise<XrManifestEntry[]> {
  const all: XrManifestEntry[] = [];
  for (const s of sources.values()) {
    try {
      const entries = await s.buildEntries();
      all.push(...entries);
    } catch {
      /* a source that cannot build right now is skipped, never fatal */
    }
  }
  return all;
}

async function publishManifest(): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const entries = await buildManifest();
  ws.send(JSON.stringify({ type: 'manifest', version: manifestVersion, entries }));
}

/** Mirror a host-side value move to XR so its widget follows theDAW state. */
export function publishControlChanged(id: string, value: XrControlValue): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'control-changed', id, value }));
  }
}

// ── Pairing posture (host side) ──────────────────────────────────────────────
// This browser is the HOST. It declares the session pairing posture to the
// relay: "open" lets any LAN controller in; "code" requires the QR's pair code.
// The relay gates controllers on it (see docs/companion-control-contract.md).

export type XrPostureMode = 'open' | 'code';
export interface XrHostPosture {
  mode: XrPostureMode;
  code: string | null;
}
/** A connected, authenticated controller peer (phone / companion). */
export interface XrPeer {
  peerId: number;
  label: string;
}

let hostPosture: XrHostPosture = { mode: 'open', code: null };
let peers: XrPeer[] = [];
const peerListeners = new Set<(p: XrPeer[]) => void>();

function emitPeers(): void {
  const snapshot = peers.slice();
  for (const l of peerListeners) {
    try {
      l(snapshot);
    } catch {
      /* a listener that throws must not break the others */
    }
  }
}

function sendHostHello(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'host-hello', posture: hostPosture }));
  }
}

/** Set the pairing posture (called from the desktop Phone panel). Persists in
 *  memory and re-declares to the relay when connected. */
export function setXrHostPosture(posture: XrHostPosture): void {
  hostPosture = {
    mode: posture.mode === 'code' ? 'code' : 'open',
    code: posture.code || null,
  };
  sendHostHello();
}

export function getXrHostPosture(): XrHostPosture {
  return hostPosture;
}

/** Subscribe to the connected-companion list; fires immediately with current. */
export function onXrPeersChanged(cb: (peers: XrPeer[]) => void): () => void {
  peerListeners.add(cb);
  cb(peers.slice());
  return () => {
    peerListeners.delete(cb);
  };
}

export function getXrPeers(): XrPeer[] {
  return peers.slice();
}

/** Revoke a connected companion by id. */
export function kickXrPeer(peerId: number): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'kick', peerId }));
  }
}

async function applyControlSet(id: string, value: XrControlValue): Promise<void> {
  const area = id.split('.')[0];
  const source = sources.get(area);
  if (!source) return;
  try {
    await source.apply(id, value);
  } catch {
    /* a setter that throws (e.g. engine not started yet) is non-fatal */
  }
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, 2000);
}

function connect(): void {
  if (!running || ws) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    everConnected = true;
    logInfo('xrcontrol', 'XR control bus connected.');
    // Declare this browser the host + its pairing posture, then seed any
    // controller already waiting on the relay.
    sendHostHello();
    void publishManifest();
  };
  sock.onmessage = (e) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof e.data === 'string' ? e.data : '');
    } catch {
      return; /* ignore malformed frame */
    }
    if (!parsed || typeof parsed !== 'object') return;
    const m = parsed as {
      type?: unknown;
      id?: unknown;
      value?: unknown;
      peers?: unknown;
      peerId?: unknown;
      label?: unknown;
    };
    if (typeof m.type !== 'string') return;
    if (m.type === 'request-controls') {
      void publishManifest();
    } else if (m.type === 'control-set' && typeof m.id === 'string') {
      void applyControlSet(m.id, m.value as XrControlValue);
    } else if (m.type === 'host-ack') {
      peers = Array.isArray(m.peers) ? (m.peers as XrPeer[]) : [];
      emitPeers();
    } else if (m.type === 'peer-joined' && typeof m.peerId === 'number') {
      const label = typeof m.label === 'string' ? m.label : 'device';
      if (!peers.some((p) => p.peerId === m.peerId)) {
        peers = [...peers, { peerId: m.peerId as number, label }];
        emitPeers();
      }
    } else if (m.type === 'peer-left' && typeof m.peerId === 'number') {
      peers = peers.filter((p) => p.peerId !== m.peerId);
      emitPeers();
    }
  };
  sock.onerror = () => {
    try { sock.close(); } catch { /* already closing */ }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (peers.length) {
      peers = [];
      emitPeers();
    }
    if (running && everConnected) logWarn('xrcontrol', 'XR control bus disconnected — retrying…');
    scheduleReconnect();
  };
}

/** Open (and keep open) the XR control bus. Safe to call repeatedly. */
export function startXrControl(): void {
  if (running) return;
  running = true;
  everConnected = false;
  connect();
}

/** Close the bus and stop reconnecting. */
export function stopXrControl(): void {
  running = false;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  if (ws) {
    try { ws.close(); } catch { /* already closing */ }
    ws = null;
  }
}

export function isXrControlConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
