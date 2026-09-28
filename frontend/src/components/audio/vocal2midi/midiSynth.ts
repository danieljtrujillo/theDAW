/**
 * vocal2midi synth shim — preserves the original MidiSynth public API the ported
 * components rely on (play/playNotes/stop/setInstrument/renderToWav/getInstrumentList/
 * getMidiSynth) but voices everything through theDAW's FULL soundfont library
 * (SpessaSynth + the bundled General MIDI SF3) instead of the suite's CDN
 * soundfont-player. Instrument selection maps onto General MIDI programs; the
 * compact panel also exposes theDAW's own instrument picker for the full 128-program
 * range. WAV export uses theDAW's offline soundfont render.
 *
 * The panel's voice is the voice the piano roll's active part plays
 * (lib/rollPartVoice). The assistant's instrument choice and the panel's ROLL VOICE
 * select set it through lib/rollVoiceChoice: on a roll linked to an EDIT clip
 * they set that clip's track instrument, and on an unlinked roll the roll's own
 * voice (pianoRollStore `voiceProgram`), and on a part with a program of its
 * own that program. The panel previews and exports with
 * it. It never writes the global picker, whose program every EDIT clip without
 * one of its own follows. Left unset, all of them play the picker's program.
 */
import type { NoteEvent } from './types';
import {
  getActiveProgram,
  previewNoteSF,
  renderNotesToBlobSF,
  liveAllNotesOff,
} from '../../../lib/soundfontEngine';
import type { RenderNote } from '../../../lib/midiSynth';
import type { ClipVoice } from '../../../lib/clipProgram';
import { rollPartVoice } from '../../../lib/rollPartVoice';
import { chooseRollVoice } from '../../../lib/rollVoiceChoice';
import { DRUM_CHANNEL } from '../../../lib/editChannels';
import { getEngineCtx } from '../../../state/playerStore';

export type InstrumentType = 'synth' | 'piano' | 'kick' | 'bass' | 'guitar' | 'strings' | 'organ';

/** Map the suite's 7 named instruments onto General MIDI programs in theDAW's
 *  full soundfont. The panel's main instrument control is theDAW's own picker,
 *  which can reach all 128 programs; this map keeps the assistant's
 *  `controlPlayback` instrument argument and the legacy dropdown working. */
const INSTRUMENT_GM: Record<InstrumentType, { name: string; program: number }> = {
  piano: { name: 'Grand Piano', program: 0 },
  synth: { name: 'Synth Lead', program: 80 },
  bass: { name: 'Electric Bass', program: 33 },
  guitar: { name: 'Acoustic Guitar', program: 24 },
  kick: { name: 'Synth Drum', program: 118 },
  strings: { name: 'String Ensemble', program: 48 },
  organ: { name: 'Rock Organ', program: 18 },
};

/** The voice the panel previews and renders with: the roll's (its linked
 *  clip's, else its own), with the picker's program when that has none. */
export const vocalVoice = (): ClipVoice => {
  // The active part's voice (lib/rollPartVoice): its own program, else its linked clip's, else the roll's.
  const voice = rollPartVoice();
  return { program: voice.program ?? getActiveProgram(), percussion: voice.percussion };
};

/** The program the panel previews and renders with (see vocalVoice). */
export const vocalVoiceProgram = (): number => vocalVoice().program ?? getActiveProgram();

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const toRenderNotes = (notes: NoteEvent[]): RenderNote[] =>
  notes.map((n) => ({
    midi: Math.round(n.midiNote),
    startSec: Math.max(0, n.startTime),
    durationSec: Math.max(0.05, n.duration),
    velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
  }));

export class MidiSynth {
  private instrument: InstrumentType = 'synth';
  private volume = 0.5;
  private timers: number[] = [];
  private endTimer: number | null = null;
  private playing = false;
  private startedAt = 0;
  private startOffset = 0;

  setInstrument(instrument: InstrumentType): Promise<void> {
    this.instrument = instrument;
    chooseRollVoice(INSTRUMENT_GM[instrument].program);
    return Promise.resolve();
  }

  getInstrument(): InstrumentType {
    return this.instrument;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
  }

  /**
   * Schedule a note sequence through theDAW's soundfont. `startFromTime` seeks
   * into the sequence (notes before it are skipped). Each note triggers a live
   * soundfont voice at its absolute start, scaled by the synth volume.
   */
  playNotes(notes: NoteEvent[], onEnd?: () => void, startFromTime = 0): Promise<void> {
    this.stop();
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    this.playing = true;
    this.startOffset = startFromTime;
    this.startedAt = now();
    let maxEnd = 0;
    for (const n of notes) {
      const end = n.startTime + n.duration;
      if (end > maxEnd) maxEnd = end;
      const at = n.startTime - startFromTime;
      if (at < 0) continue;
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * (0.4 + this.volume * 0.6))));
      const id = window.setTimeout(() => {
        const voice = vocalVoice();
        void previewNoteSF(n.midiNote, vel, n.duration, voice.percussion ? DRUM_CHANNEL : 0, undefined, voice.program);
      }, Math.max(0, at * 1000));
      this.timers.push(id);
    }
    const totalMs = Math.max(0, maxEnd - startFromTime) * 1000 + 250;
    this.endTimer = window.setTimeout(() => {
      this.playing = false;
      this.endTimer = null;
      onEnd?.();
    }, totalMs);
    return Promise.resolve();
  }

  /** Alias kept for callers that use `play(notes, bpm)`. */
  async play(notes: NoteEvent[], _bpm?: number): Promise<void> {
    return this.playNotes(notes);
  }

  stop(): void {
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers = [];
    if (this.endTimer != null) {
      window.clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.playing = false;
    try {
      liveAllNotesOff();
    } catch {
      /* ignore */
    }
  }

  isCurrentlyPlaying(): boolean {
    return this.playing;
  }

  getPlaybackPosition(): number {
    if (!this.playing) return 0;
    return this.startOffset + (now() - this.startedAt) / 1000;
  }

  /** Render the notes to a WAV Blob through theDAW's offline soundfont render. */
  async renderToWav(notes: NoteEvent[]): Promise<Blob> {
    const voice = vocalVoice();
    const render = toRenderNotes(notes);
    const { blob } = await renderNotesToBlobSF(voice.percussion ? render.map((n) => ({ ...n, channel: DRUM_CHANNEL })) : render, { program: voice.program });
    return blob;
  }

  dispose(): void {
    this.stop();
  }
}

let singleton: MidiSynth | null = null;

export function getMidiSynth(): MidiSynth {
  if (!singleton) singleton = new MidiSynth();
  return singleton;
}

export function getInstrumentList(): { id: InstrumentType; name: string }[] {
  return (Object.keys(INSTRUMENT_GM) as InstrumentType[]).map((id) => ({ id, name: INSTRUMENT_GM[id].name }));
}
