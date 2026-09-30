/**
 * Global MIDI event bus.
 *
 * One Web MIDI listener lives in App.tsx; it dispatches every
 * incoming message through this bus. Any feature that wants raw
 * MIDI input (VJ iframe forwarder, the MidiMapper popups in
 * PianoRoll and StepSequencer) subscribes here instead of opening
 * its own MIDIAccess — that way only ONE handler is attached to
 * each MIDIInput, so we don't have the last-listener-wins problem
 * that the VJView used to have. The built-in piano synth is NOT a
 * subscriber: App.tsx triggers it directly off raw `e.data` before
 * this bus ever sees the message, so it repeats the ignore check
 * itself (see App.tsx's onMidiMessage) rather than relying on this
 * module's filtering.
 *
 * Per-control ignore (FE-010) is enforced HERE, unlike port
 * filtering (see App.tsx): a CC/note the user has marked "Ignore"
 * in the DJ MIDI map must stay silent for every bus subscriber and
 * every source — Web MIDI, the Quest bridge, and synthetic Sway
 * surface messages alike — so dropping it before dispatch is the
 * one place that reaches all of them. NOTE-OFF is the one
 * exception: it always passes, ignored or not, so a note that was
 * already sounding when it got ignored (or whose note-on slipped
 * through before the ignore was added) can still be released —
 * otherwise it hangs stuck-on in MIDI capture (midiCapture.ts's
 * held-note tracking never sees the matching off).
 */

import { isMidiMessageIgnored } from './midiIgnoreStore';

export interface MidiBusMessage {
  /** 3-byte MIDI status + data1 + data2 (or shorter for system messages). */
  data: number[];
  /** Performance.now() at dispatch time. */
  t: number;
}

type MidiListener = (msg: MidiBusMessage) => void;

const listeners = new Set<MidiListener>();

/** True for note-off (0x80) and note-on-with-velocity-0 (the "running status"
 *  note-off some controllers send instead of a real 0x80). */
function isNoteOffMessage(data: number[]): boolean {
  const status = data[0];
  if (typeof status !== 'number') return false;
  const command = status & 0xf0;
  if (command === 0x80) return true;
  if (command === 0x90) return (data[2] ?? 0) === 0;
  return false;
}

export function publishMidi(data: Uint8Array | number[], t: number = performance.now()): void {
  const arr = Array.from(data, (n) => Number(n) | 0);
  if (!isNoteOffMessage(arr) && isMidiMessageIgnored(arr)) return;
  const msg: MidiBusMessage = { data: arr, t };
  for (const cb of listeners) {
    try {
      cb(msg);
    } catch (err) {
      // A faulty subscriber should not silence the rest of the bus.
      console.error('[midiBus] subscriber threw:', err);
    }
  }
}

export function subscribeToMidi(cb: MidiListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

