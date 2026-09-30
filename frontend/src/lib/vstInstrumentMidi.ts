/**
 * vstInstrumentMidi — an EDIT track's MIDI as the messages its VST3
 * instrument plays, for the offline print (POST /api/vst/render-midi) and the
 * live host (the `midi` op of docs/design/vst-live-protocol.md).
 *
 * The notes, controllers and bends come from lib/arrangementMidi, the same
 * walk the arrangement's MIDI export makes: every clip's notes at the second
 * EDIT plays them, through the clip's tempo map and trim, each part's
 * controllers (CC 1, 7, 10, 11, 64 and any other the part writes) with the
 * state held where a trimmed clip starts and the reset where a clip ends, and
 * each bent lane on a channel of its own with its RPN 0/0 range and wheel. The
 * track is read at EDIT's default fader and centre pan, since the fader and
 * pan act on the instrument's audio after it, on the track's strip. Program
 * changes and bank selects are left out: a VST3 instrument plays the preset
 * the user dialled into it, and a General MIDI program number would switch it
 * to whatever preset sits at that number.
 *
 * Articulations: a VST3 instrument has no General MIDI preset for a pizzicato
 * channel, so every note stays on its lane's channel, shaped by its
 * articulation as EDIT's live feed plays it, and each change of articulation
 * is the switch the track's `articulationSwitch` names (lib/articulationMap
 * vst3SwitchEvents): a keyswitch note one tick long, or a UACC value on CC 32,
 * one tick before the note, on every channel the track's notes play on. Once
 * any note uses an articulation, the first note's switch goes out too, so the
 * print starts on the articulation its first note plays whatever the plugin's
 * saved state was left on.
 *
 * Pure (no stores), so node tests run it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { clipPeakGain } from '../state/editorStore';
import { fadeGainAt } from './clipFade';
import { readWavSamples, writeFloatWav } from './wavSamples';
import { EDIT_DEFAULT_VOLUME, arrangementToMidiFile, type ArrangementMidiSource } from './arrangementMidi';
import { isVst3SwitchMode, usesArticulations, vst3SwitchEvents, type Vst3Articulations } from './articulationMap';
import type { GlobalVoice } from './clipProgram';
import { sanitizeRollTempoMap } from './rollTempo';
import { beatToTime } from './tempoMap';

/** One channel voice message at a second of the timeline. */
export interface InstrumentMidiMessage {
  /** Timeline seconds. */
  t: number;
  /** The status byte, then its data bytes. */
  data: number[];
}

/** Seconds the print renders past the last message, for the instrument's release and room to ring out. */
export const INSTRUMENT_TAIL_SEC = 4;

/** At equal times: note-offs first, then controllers and bend ranges, then wheels, then note-ons. */
const ORDER = { off: 0, control: 1, wheel: 2, on: 3 } as const;

/** The clips of a track that its instrument plays: piano-roll clips with notes. */
export const isInstrumentClip = (c: AudioClip): boolean =>
  c.sourceKind === 'piano-roll' && (c.sourcePianoRoll?.length ?? 0) > 0;

/**
 * How `track`'s VST3 instrument is told the articulations of `clips` (the
 * clips it plays): the track's switch mode, keyswitch when it names none, and
 * an opening switch once any of their notes uses an articulation.
 */
export function trackVst3Articulations(
  track: Pick<EditorTrack, 'articulationSwitch'>,
  clips: readonly Pick<AudioClip, 'sourcePianoRoll' | 'sourceRollNotes'>[],
): Vst3Articulations {
  return {
    mode: isVst3SwitchMode(track.articulationSwitch) ? track.articulationSwitch : 'keyswitch',
    opening: clips.some((c) => usesArticulations(c.sourcePianoRoll ?? c.sourceRollNotes ?? [])),
  };
}

/**
 * Every message `track`'s instrument plays for `clipIds` (all of the track's
 * piano-roll clips when left out), in time order. Muted clips play nothing,
 * as they play nothing in the arrangement's MIDI export.
 */
export function trackInstrumentMessages(
  source: ArrangementMidiSource,
  trackId: string,
  global: GlobalVoice,
  clipIds?: readonly string[],
): InstrumentMidiMessage[] {
  const track = source.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const neutral: EditorTrack = { ...track, volume: EDIT_DEFAULT_VOLUME, pan: 0, mute: false, solo: false };
  const result = arrangementToMidiFile(
    { ...source, tracks: [neutral] },
    { scope: clipIds ? { kind: 'clips', clipIds } : { kind: 'tracks', trackIds: [trackId] }, global, vst3Articulations: true },
  );
  const mode = isVst3SwitchMode(track.articulationSwitch) ? track.articulationSwitch : 'keyswitch';
  const file = result.file;
  const bpm = Number.isFinite(source.bpm) && source.bpm > 0 ? source.bpm : 120;
  const map = sanitizeRollTempoMap(source.tempoMap?.length ? source.tempoMap : [], bpm);
  const sec = (tick: number): number => beatToTime(map, tick / file.ppq);
  const out: Array<InstrumentMidiMessage & { order: number }> = [];
  for (const mt of file.tracks) {
    // The articulation switches go in first, so a switch at a note's own instant stays ahead of it.
    const channels = [...new Set(mt.notes.map((n) => n.channel & 0x0f))].sort((a, b) => a - b);
    const switches = vst3SwitchEvents(
      mt.notes.map((n) => ({ note: n.note, step: 0, length: 0, velocity: n.velocity, articulation: n.articulation, tick: n.tick })),
      mode,
      {},
      1,
      file.ppq / 4,
      usesArticulations(mt.notes),
    );
    for (const e of switches) {
      for (const ch of channels) {
        if (e.switch.kind === 'keyswitch') {
          const key = e.switch.note & 0x7f;
          out.push({ t: sec(e.tick), data: [0x90 | ch, key, 1], order: ORDER.on });
          out.push({ t: sec(e.tick + 1), data: [0x80 | ch, key, 0], order: ORDER.off });
        } else {
          out.push({ t: sec(e.tick), data: [0xb0 | ch, e.switch.controller & 0x7f, e.switch.value & 0x7f], order: ORDER.control });
        }
      }
    }
    for (const n of mt.notes) {
      const ch = n.channel & 0x0f;
      out.push({ t: sec(n.tick), data: [0x90 | ch, n.note & 0x7f, Math.max(1, Math.min(127, n.velocity))], order: ORDER.on });
      out.push({ t: sec(n.tick + n.durationTicks), data: [0x80 | ch, n.note & 0x7f, 0], order: ORDER.off });
    }
    for (const c of mt.controls ?? []) {
      out.push({ t: sec(c.tick), data: [0xb0 | (c.channel & 0x0f), c.controller & 0x7f, c.value & 0x7f], order: ORDER.control });
    }
    for (const r of mt.bendRanges ?? []) {
      const ch = 0xb0 | (r.channel & 0x0f);
      const t = sec(r.tick);
      // RPN 0/0 (pitch bend sensitivity): select it, then the semitones in the data entry MSB, 0 cents in the LSB.
      for (const [controller, value] of [[101, 0], [100, 0], [6, r.semitones], [38, 0]]) {
        out.push({ t, data: [ch, controller, Math.max(0, Math.min(127, Math.round(value)))], order: ORDER.control });
      }
    }
    // An expressive note's pressure on its MPE member channel.
    for (const p of mt.pressures ?? []) {
      out.push({ t: sec(p.tick), data: [0xd0 | (p.channel & 0x0f), Math.max(0, Math.min(127, Math.round(p.value)))], order: ORDER.control });
    }
    for (const b of mt.bends ?? []) {
      const raw = Math.max(0, Math.min(16383, Math.round(b.value)));
      out.push({ t: sec(b.tick), data: [0xe0 | (b.channel & 0x0f), raw & 0x7f, raw >> 7], order: ORDER.wheel });
    }
  }
  // A stable sort: messages of one kind at one instant keep the order the export wrote them in.
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.t - b.m.t || a.m.order - b.m.order || a.i - b.i)
    .map(({ m }) => ({ t: m.t, data: m.data }));
}

/** One track's part of a /api/vst/render-midi request. */
export interface InstrumentRenderTrack {
  track_id: string;
  plugin_path: string;
  raw_state: string;
  /** Which host captured `raw_state`: 'thedaw' prints through our own host, which reads it. */
  state_host: string;
  params: Record<string, number>;
  /** Seconds to render from `startSec`, the tail included. */
  duration: number;
  /** Messages timed from `startSec`. */
  events: InstrumentMidiMessage[];
}

/** A print request, and where on the timeline its audio starts. */
export interface InstrumentPrintPlan {
  request: InstrumentRenderTrack;
  startSec: number;
  /** The clips the print plays, whose gain and fades shape it (instrumentGainAt). */
  clips: AudioClip[];
}

/**
 * The print of `track`'s instrument over `clips` (the track's clips the bounce
 * covers): rendered from the first clip's start, so a part entering late does
 * not render minutes of silence first, to the last message plus the tail. Null
 * when the track has no enabled instrument or its clips play nothing.
 */
export function instrumentPrintPlan(
  source: ArrangementMidiSource,
  track: EditorTrack,
  clips: readonly AudioClip[],
  global: GlobalVoice,
): InstrumentPrintPlan | null {
  const instrument = track.instrument;
  if (!instrument?.enabled || !instrument.vst) return null;
  const played = clips.filter((c) => c.trackId === track.id && isInstrumentClip(c) && !c.muted);
  if (played.length === 0) return null;
  const messages = trackInstrumentMessages(source, track.id, global, played.map((c) => c.id));
  if (messages.length === 0) return null;
  const startSec = Math.max(0, Math.min(...played.map((c) => c.startSec)));
  const lastSec = messages[messages.length - 1].t;
  return {
    startSec,
    clips: played,
    request: {
      track_id: track.id,
      plugin_path: instrument.vst.plugin_path,
      raw_state: instrument.vst.raw_state ?? '',
      state_host: instrument.vst.state_host ?? '',
      params: {},
      duration: Math.max(0.1, lastSec - startSec) + INSTRUMENT_TAIL_SEC,
      events: messages.map((m) => ({ t: Math.max(0, m.t - startSec), data: m.data })),
    },
  };
}

/**
 * The gain live playback puts on an instrument's output at timeline second `t`,
 * over the track's `clips` (the ones it plays, muted ones left out).
 *
 * Live, the instrument's output passes one envelope gain per track, and the
 * scheduler hands that envelope to each clip at the clip's start
 * (lib/editMidiScheduler scheduleEnvelope: the clip's fades with its gain as
 * the peak, lib/clipFade applyFadeAutomation). So the clip that started last
 * owns the envelope: inside its window the gain is its gain times its fade
 * curve, and past its end the envelope holds where the clip left it, so a
 * release tail rings at the clip's gain, and is silent after a fade-out.
 * Before the first clip the envelope is at unity.
 */
export function instrumentGainAt(clips: readonly AudioClip[], t: number): number {
  let owner: AudioClip | undefined;
  for (const c of clips) {
    if (c.startSec <= t + 1e-9 && (!owner || c.startSec >= owner.startSec)) owner = c;
  }
  if (!owner) return 1;
  const dur = Math.max(0, owner.durationSec);
  const rel = Math.min(Math.max(0, t - owner.startSec), dur);
  return clipPeakGain(owner) * fadeGainAt(owner, rel);
}

/** True when every clip plays at unity with no fades, so the envelope is 1 throughout. */
const flatEnvelope = (clips: readonly AudioClip[]): boolean =>
  clips.every((c) => clipPeakGain(c) === 1 && !(c.fadeInSec && c.fadeInSec > 0) && !(c.fadeOutSec && c.fadeOutSec > 0));

/**
 * The print shaped by the envelope live playback applies (instrumentGainAt):
 * each clip's gain and fades over its own span, the release after a clip at
 * the gain the clip ended on. `startSec` is where the print sits on the
 * timeline. A print whose clips all play at unity comes back as it is.
 */
export async function shapeInstrumentPrint(audio: Blob, startSec: number, clips: readonly AudioClip[]): Promise<Blob> {
  const played = clips.filter((c) => !c.muted);
  if (flatEnvelope(played)) return audio;
  const samples = readWavSamples(await audio.arrayBuffer());
  const rate = samples.sampleRate;
  for (let i = 0; i < samples.frames; i += 1) {
    const g = instrumentGainAt(played, startSec + i / rate);
    if (g === 1) continue;
    for (const ch of samples.channels) ch[i] *= g;
  }
  return writeFloatWav(samples);
}

/** One track as /api/vst/render-midi answered it. */
export interface InstrumentRenderResult {
  trackId: string;
  audio: Blob;
  frames: number;
  sampleRate: number;
  warnings: string[];
}

interface RenderReport {
  tracks: Array<{ track_id: string; part: string; frames: number; sample_rate: number; warnings: string[] }>;
}

/** Read the route's multipart answer: its `report` part names each track's WAV part. */
export async function parseInstrumentRender(form: FormData): Promise<InstrumentRenderResult[]> {
  const reportPart = form.get('report');
  if (reportPart === null) throw new Error('the instrument render answered without a report');
  const text = typeof reportPart === 'string' ? reportPart : await reportPart.text();
  const report = JSON.parse(text) as RenderReport;
  return report.tracks.map((r) => {
    const part = form.get(r.part);
    if (!(part instanceof Blob)) throw new Error(`the instrument render lost the audio of track ${r.track_id}`);
    return {
      trackId: r.track_id,
      audio: part.type ? part : new Blob([part], { type: 'audio/wav' }),
      frames: r.frames,
      sampleRate: r.sample_rate,
      warnings: r.warnings ?? [],
    };
  });
}
