/**
 * Quest MIDI client — the loopMIDI-free path.
 *
 * Holds a WebSocket to the backend `questmidi` module (`/api/questmidi/ws`),
 * which bridges the Quest app over USB (adb reverse) with no loopMIDI and no
 * separate Node bridge. Inbound Quest MIDI is republished on the global
 * `midiBus`, so every existing consumer (piano synth, VJ forwarder, MidiMapper,
 * the questControlStore) sees it exactly like a hardware controller. Return MIDI
 * (e.g. an audio-reactive feed for the headset MIDI Reactor) goes back via
 * `sendQuestMidi`.
 *
 * The socket opens with one status frame, which goes to questMidiStatus.ts:
 * when another program serves the headset's port, the LOG and the orb say
 * which one, and Settings → Inputs & outputs offers Take over.
 *
 * Same-origin URL on an http(s) page, so it rides the Vite dev proxy (ws:true) in
 * development; the desktop app:// renderer dials the local backend directly
 * (see wsUrl). Auto-reconnects while running.
 */

import { publishMidi } from './midiBus';
import { logInfo, logWarn } from './logStore';
import { useQuestMidiStatusStore } from './questMidiStatus';

let ws: WebSocket | null = null;
let reconnectTimer = 0;
let running = false;
let everConnected = false;

function wsUrl(): string {
  const { protocol, host } = window.location;
  if (protocol === 'https:') {
    // Hosted over TLS: same-origin so the deployment's proxy carries it.
    return `wss://${host}/api/questmidi/ws`;
  }
  if (protocol === 'http:' && host) {
    // Served over http from the LAN origin (desktop web dev on
    // localhost:5173, or a phone/companion on <lan-ip>:5173 in dev /
    // <lan-ip>:8600 packaged). Derive from the origin so a device connects to
    // its own host, not to whichever machine happens to run the browser; the
    // Vite proxy carries the upgrade in dev (server.proxy['/api'].ws = true)
    // and it is direct in packaged/Docker. Same fix as xrControlClient.ts.
    return `ws://${host}/api/questmidi/ws`;
  }
  // Desktop app:// renderer — its protocol handler proxies HTTP /api/* but
  // cannot upgrade WebSockets, and the backend is always local on :8600.
  // 127.0.0.1, never 'localhost': the backend binds 0.0.0.0 (IPv4 only) and
  // Chromium resolves 'localhost' to ::1 on Windows, so the socket never
  // connects (issue #144). The LAN case is handled above, by origin.
  return 'ws://127.0.0.1:8600/api/questmidi/ws';
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
    logInfo('questmidi', 'Bridge connected (no loopMIDI).');
  };
  sock.onmessage = (e) => {
    try {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : '');
      if (m && m.type === 'midi' && Array.isArray(m.data)) publishMidi(m.data);
      else if (m && m.type === 'status') useQuestMidiStatusStore.getState().apply(m);
    } catch {
      /* ignore malformed frame */
    }
  };
  sock.onerror = () => {
    try { sock.close(); } catch { /* already closing */ }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (running && everConnected) logWarn('questmidi', 'Bridge disconnected — retrying…');
    scheduleReconnect();
  };
}

/** Open (and keep open) the Quest MIDI bridge. Safe to call repeatedly. */
export function startQuestMidi(): void {
  if (running) return;
  running = true;
  everConnected = false;
  connect();
}

/** Close the bridge and stop reconnecting. */
export function stopQuestMidi(): void {
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

/** Send return MIDI to the headset (e.g. to drive the GANTASMO Visor). */
export function sendQuestMidi(data: number[]): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ data }));
    return true;
  }
  return false;
}

export function isQuestMidiConnected(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
