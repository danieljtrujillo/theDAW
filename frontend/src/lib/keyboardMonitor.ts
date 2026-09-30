/**
 * keyboardMonitor — a hardware keyboard heard from note-on to note-off.
 *
 * Each key sounds from its note-on until its note-off. While the sustain pedal
 * (CC64 at 64 or more) is down on a MIDI channel, a released key keeps sounding
 * until the pedal lifts; a key struck again while it rings is released first,
 * so it restarts on a fresh voice. CC120 (all sound off) and CC123 (all notes
 * off) release every key on their channel.
 *
 * The voice is the armed MIDI track's (`monitorVoice`): its program, on the
 * drum channel when it is a percussion track, so what the player hears is what
 * the take will play. With no armed MIDI track it is the global picker's. A
 * key keeps the voice it started with until it is released, so arming another
 * track mid-note cannot strand it.
 *
 * A PURE CORE: the voice and the sound come in through `KeyboardMonitorDeps`
 * (App.tsx supplies the soundfont and built-in voices), and the imports here
 * are pure, so node tests replay a performance against it.
 */
import type { EditorTrack } from '../state/editorStore';
import { clipVoice, type ClipVoice, type GlobalVoice } from './clipProgram';
import { capturesMidi, type CaptureClip } from './midiCapture';

/** A key that is sounding: what it plays, and on which voice. */
export interface HeldKey {
  /** The MIDI channel of the keyboard message (0-15), not the synth's channel. */
  source: number;
  note: number;
  velocity: number;
  voice: ClipVoice;
}

export interface KeyboardMonitorDeps {
  /** The voice a key struck now plays with (`monitorVoice`). */
  voice: () => ClipVoice;
  /** Start sounding `key`. Returns the handle `stop` takes. */
  start: (key: HeldKey) => unknown;
  /** Stop the key `start` returned `handle` for. */
  stop: (handle: unknown, key: HeldKey) => void;
}

export interface KeyboardMonitor {
  /** Feed one raw MIDI message (note-on, note-off, controller). Others are ignored. */
  message: (data: ArrayLike<number>) => void;
  /** Release every key and lift every pedal (MIDI turned off, the page closing). */
  panic: () => void;
  /** Keys sounding now, held or sustained. Tests read it. */
  sounding: () => HeldKey[];
}

export const SUSTAIN_CC = 64;
const ALL_SOUND_OFF_CC = 120;
const ALL_NOTES_OFF_CC = 123;

interface Voice {
  key: HeldKey;
  handle: unknown;
  /** True once the key is up and only the pedal holds it. */
  pedalled: boolean;
}

export function createKeyboardMonitor(deps: KeyboardMonitorDeps): KeyboardMonitor {
  const voices = new Map<string, Voice>();
  const pedalDown = new Set<number>();
  const id = (source: number, note: number): string => `${source}:${note}`;

  const release = (k: string): void => {
    const v = voices.get(k);
    if (!v) return;
    voices.delete(k);
    deps.stop(v.handle, v.key);
  };

  const releaseWhere = (keep: (v: Voice) => boolean): void => {
    for (const [k, v] of [...voices]) if (!keep(v)) release(k);
  };

  const noteOn = (source: number, note: number, velocity: number): void => {
    const k = id(source, note);
    release(k); // a key struck again while it rings restarts on a fresh voice
    const key: HeldKey = { source, note, velocity, voice: deps.voice() };
    voices.set(k, { key, handle: deps.start(key), pedalled: false });
  };

  const noteOff = (source: number, note: number): void => {
    const k = id(source, note);
    const v = voices.get(k);
    if (!v) return;
    if (pedalDown.has(source)) v.pedalled = true;
    else release(k);
  };

  const controller = (source: number, cc: number, value: number): void => {
    if (cc === SUSTAIN_CC) {
      if (value >= 64) {
        pedalDown.add(source);
        return;
      }
      pedalDown.delete(source);
      releaseWhere((v) => v.key.source !== source || !v.pedalled);
      return;
    }
    if (cc === ALL_SOUND_OFF_CC || cc === ALL_NOTES_OFF_CC) {
      pedalDown.delete(source);
      releaseWhere((v) => v.key.source !== source);
    }
  };

  return {
    message: (data) => {
      if (data.length < 2) return;
      const status = data[0] & 0xff;
      const kind = status & 0xf0;
      const source = status & 0x0f;
      const d1 = data[1] & 0x7f;
      const d2 = data.length > 2 ? data[2] & 0x7f : 0;
      if (kind === 0x90 && d2 > 0) noteOn(source, d1, d2);
      else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) noteOff(source, d1);
      else if (kind === 0xb0) controller(source, d1, d2);
    },
    panic: () => {
      pedalDown.clear();
      releaseWhere(() => false);
    },
    sounding: () => [...voices.values()].map((v) => v.key),
  };
}

/** The armed track a hardware keyboard plays: the first in track order that records MIDI, or undefined when none is armed. */
export function monitoredTrack<T extends Pick<EditorTrack, 'id' | 'color' | 'instrumentProgram' | 'isPercussion'>>(
  armedTrackIds: readonly string[],
  tracks: readonly T[],
  clips: readonly CaptureClip[],
): T | undefined {
  const armed = new Set(armedTrackIds);
  return tracks.find((t) => armed.has(t.id) && capturesMidi(t, clips));
}

/**
 * The voice a hardware keyboard plays with: the first armed track in track
 * order that records MIDI (lib/midiCapture capturesMidi), through its program
 * and drum flag (lib/clipProgram). With none armed, the global picker's
 * program (none on Basic or a synth voice, which play the built-in voice).
 */
export function monitorVoice(
  armedTrackIds: readonly string[],
  tracks: ReadonlyArray<Pick<EditorTrack, 'id' | 'color' | 'instrumentProgram' | 'isPercussion'>>,
  clips: readonly CaptureClip[],
  global: GlobalVoice,
): ClipVoice {
  const track = monitoredTrack(armedTrackIds, tracks, clips);
  if (track) return clipVoice({}, track, global);
  return { program: global.useSoundfont ? global.activeProgram : undefined, percussion: false };
}

