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
 * Pure (no stores), so node tests run it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { EDIT_DEFAULT_VOLUME, arrangementToMidiFile, type ArrangementMidiSource } from './arrangementMidi';
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
    { scope: clipIds ? { kind: 'clips', clipIds } : { kind: 'tracks', trackIds: [trackId] }, global },
  );
  const file = result.file;
  const bpm = Number.isFinite(source.bpm) && source.bpm > 0 ? source.bpm : 120;
  const map = sanitizeRollTempoMap(source.tempoMap?.length ? source.tempoMap : [], bpm);
  const sec = (tick: number): number => beatToTime(map, tick / file.ppq);
  const out: Array<InstrumentMidiMessage & { order: number }> = [];
  for (const mt of file.tracks) {
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
