/**
 * MIDI thru — the one net-new capability of the I/O menu.
 *
 * Everything that arrives on the MIDI bus (hardware ports, the Quest bridge,
 * the Sway surface) is forwarded byte-for-byte to one chosen output port, so a
 * controller can drive an external synth or a DAW over a virtual cable while
 * theDAW is playing it too.
 *
 * Default is NO target, and with no target this module subscribes to nothing
 * and sends nothing — it cannot surprise a user who never opens the menu. It is
 * also thru ONLY: theDAW generates no clock, MTC or song-position, so none is
 * sent (a clock generator is a separate feature, not a checkbox).
 *
 * App.tsx owns the single requestMIDIAccess and hands the output ports here.
 */
import type { DeviceRef, LiveDevice } from '../lib/ioResolve';
import { resolveRef } from '../lib/ioResolve';
import { logError, logInfo } from './logStore';
import { subscribeToMidi } from './midiBus';

interface OutPort {
  id: string;
  name: string;
  send: (data: number[]) => void;
}

let ports: OutPort[] = [];
let wanted: DeviceRef = { id: '', label: '' };
let activeId = '';
let unsubscribe: (() => void) | null = null;

/** The output ports as live devices, for the menu. */
export const midiOutDevices = (): LiveDevice[] => ports.map((p) => ({ id: p.id, label: p.name }));

/** The port thru is actually sending to ('' = nothing is being sent). */
export const activeThruPortId = (): string => activeId;

const stop = (): void => {
  unsubscribe?.();
  unsubscribe = null;
  activeId = '';
};

const start = (port: OutPort): void => {
  if (activeId === port.id && unsubscribe) return;
  stop();
  activeId = port.id;
  unsubscribe = subscribeToMidi((msg) => {
    try {
      port.send(msg.data);
    } catch (e) {
      // A port that vanished mid-stream throws on every message; stop rather
      // than flooding the log, and let the next re-sync pick it up again.
      logError('midi', `MIDI thru to ${port.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      stop();
    }
  });
  logInfo('midi', `MIDI thru -> ${port.name}`);
};

/** Re-evaluate the wanted target against the ports currently open. */
const sync = (): void => {
  if (!wanted.id && !wanted.label) {
    if (activeId) logInfo('midi', 'MIDI thru off');
    stop();
    return;
  }
  const resolved = resolveRef(wanted, midiOutDevices(), true);
  const port = ports.find((p) => p.id === resolved.deviceId);
  if (!port) {
    stop();
    return;
  }
  start(port);
};

/** App.tsx publishes the open output ports here (initial + every statechange). */
export const setMidiOutputPorts = (list: OutPort[]): void => {
  ports = list;
  sync();
};

/** The chosen thru target. An empty ref means nothing is forwarded at all. */
export const setMidiThruTarget = (ref: DeviceRef): void => {
  wanted = { id: ref.id ?? '', label: ref.label ?? '' };
  sync();
};
