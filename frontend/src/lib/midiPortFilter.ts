/**
 * Which MIDI input ports are allowed to reach the app.
 *
 * The filter belongs at the Web MIDI boundary in App.tsx (where `input.id` is
 * still in hand), NOT inside midiBus: the bus also carries the Quest bridge and
 * the synthetic Sway surface, neither of which is a Web MIDI port, and filtering
 * there would silence both.
 *
 * Default is `mode: 'all'` — a controller plugged in after the user made their
 * choice must work without a trip to Settings. `mode: 'some'` with an empty
 * list is a real choice (every controller muted), not a malformed setting; a
 * config that is genuinely malformed fails OPEN, because a broken preference
 * must never be the reason a keyboard went dead.
 *
 * Pure: no Web MIDI, no DOM. Pinned in midiPortFilter.test.ts.
 */
import type { DeviceRef } from './ioResolve';

/**
 * The Quest headset bridge publishes onto the MIDI bus over a WebSocket
 * (state/questMidiClient.ts), so it has no MIDIInput and no port id. It is
 * listed here so the menu can show it, and it is never filtered out.
 */
export const QUEST_PORT: DeviceRef = { id: 'thedaw:quest', label: 'Quest bridge (USB)' };

export interface MidiInputConfig {
  mode: 'all' | 'some';
  ports: DeviceRef[];
}

export const DEFAULT_MIDI_INPUT_CONFIG: MidiInputConfig = { mode: 'all', ports: [] };

/** Minimal shape of a Web MIDI input; `MIDIInput` satisfies it. */
export interface MidiPortLike {
  id: string;
  name?: string | null;
}

/** Coerce whatever the settings payload carried into a usable config. */
export function normalizeMidiInputConfig(raw: unknown): MidiInputConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MIDI_INPUT_CONFIG };
  const obj = raw as { mode?: unknown; ports?: unknown };
  const mode = obj.mode === 'some' ? 'some' : 'all';
  const ports = Array.isArray(obj.ports)
    ? obj.ports
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({ id: String(p.id ?? ''), label: String(p.label ?? '') }))
        .filter((p) => p.id || p.label)
    : [];
  return { mode, ports };
}

/**
 * Is this port allowed through?
 *
 * Matching mirrors ioResolve: by id first, then by name — two identical
 * controllers share a name but never an id, and an id can rotate between
 * sessions while the name does not.
 */
export function midiPortAllowed(port: MidiPortLike, cfg: MidiInputConfig | null | undefined): boolean {
  if (!cfg || cfg.mode !== 'some') return true;
  if (port.id === QUEST_PORT.id) return true;
  const name = port.name ?? '';
  return cfg.ports.some((p) => (p.id && p.id === port.id) || (!!p.label && p.label === name));
}

/** "All inputs (2)" / "2 of 3 inputs" / "No MIDI inputs" for the menu row. */
export function describeMidiInputs(cfg: MidiInputConfig, connected: number): string {
  if (cfg.mode === 'all') return `All inputs (${connected})`;
  if (cfg.ports.length === 0) return 'No inputs';
  return `${cfg.ports.length} of ${connected} input${connected === 1 ? '' : 's'}`;
}

/** Add or remove one port from an explicit list, returning a complete config. */
export function toggleMidiPort(cfg: MidiInputConfig, ref: DeviceRef, on: boolean): MidiInputConfig {
  const without = cfg.ports.filter((p) => p.id !== ref.id);
  return { mode: 'some', ports: on ? [...without, { ...ref }] : without };
}
