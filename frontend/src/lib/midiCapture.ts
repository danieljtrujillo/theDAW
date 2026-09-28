/**
 * midiCapture — live MIDI input recorded onto the armed MIDI track, anchored to
 * TRANSPORT time.
 *
 * Why this exists
 * ---------------
 * `state/midiBus.ts` carries every inbound message, but nothing on the bus ever
 * kept one: the two readers are `publishMidi`'s subscribers (VJ forwarder, the
 * MidiMapper popups) and `lib/keyboardMonitor`, which sounds each key while it
 * is held and keeps nothing. Pressing RECORD with a controller plugged in armed the mic and
 * nothing else — a played part vanished the moment the voice decayed. This
 * module pairs note-on/note-off into held notes stamped with the transport
 * second they were played at, and turns a pass into a piano-roll clip on the
 * armed instrument track.
 *
 * The transport rule is `lib/recordingEngine.ts`'s (D13): a note is stamped
 * with `deps.transportSec()` AT THE MOMENT THE MESSAGE ARRIVES, never with the
 * bus message's own `t` (which is `performance.now()`, wall clock — it says
 * when the byte arrived, not where the playhead was).
 *
 * Shape
 * -----
 * A PURE CORE — `parseMidiMessage`, `createNoteCapture`, `cropNotesToWindow`,
 * and `lib/takeNotes.takeToRoll` for the seconds-to-ticks step — with no
 * imports that load a store: every store, clock, render and notice the runtime
 * needs is a `MidiCaptureDeps` entry supplied by the one `startMidiCapture()`
 * mount in `App.tsx`. The runtime imports are pure modules that load no store:
 * `lib/takeNotes` (whose only import is `lib/noteClock`, which has none),
 * `lib/clipProgram`, `lib/clipRenderWindow` and `lib/rollTracks` (the part
 * controllers a pass keeps); the rest are `import type`, erased at compile.
 *
 * Per-note expression (MPE)
 * -------------------------
 * An MPE controller plays each note on a channel of its own and shapes it
 * with that channel's pressure (D0), CC 74 and pitch wheel. A pass keeps, for
 * each held note, where its channel's three were when it started and every
 * change while it sounds (parseExpressionMessage), and when the pass played
 * notes on two or more channels (an MPE pass) they land as each note's own
 * expression (PianoNote `expr`: pressure, timbre, bend at 48 semitones, and
 * their curves; lib/noteExpression), and the pass's CC 74 is the notes', not
 * the part's. A pass on one channel keeps none: one keyboard's aftertouch and
 * wheel move every note it holds, not one.
 *
 * Controllers
 * -----------
 * A pass keeps the controller changes a roll part keeps (lib/rollTracks
 * PART_CONTROLLERS: modulation, volume, pan, expression, the sustain pedal,
 * brightness and the reverb send), each stamped with the transport second it
 * arrived at, as a note is. They land on the take as its roll part's
 * controller changes (AudioClip `sourceRollPart` controls), the list EDIT
 * plays live, renders and exports, and the roll's CC lane draws. So the core is testable under plain `tsx` with no DOM, no
 * store graph and — the point — no real MIDI device.
 *
 * Design source
 * -------------
 * theDAW's own `state/recordingStore.ts` (`placeTakes`, and its private
 * `punchWindow`) is the precedent this follows for landing a pass: ONE
 * `beginUndoStep()` for the whole pass and the clip added synchronously. A take
 * whose track or picker gives it a program plays live on EDIT's synths and has
 * no audio of its own until an export renders it (lib/midiRender); a take with
 * no program cannot play live, so its rendered audio is applied afterwards
 * through the history-exempt `applyClipRender`, marked as made so it can be
 * heard (EDIT drops it once the take plays live). No reference DAW under
 * `oss-refs/` was opened while writing this file and no code is copied from one.
 */

import type { AudioClip, EditorTrack } from '../state/editorStore';
import { clipVoice, renderedVoiceFields, type ClipVoice } from './clipProgram';
import { renderedWindowFields, type RenderWindowClip } from './clipRenderWindow';
import type { MidiBusMessage } from '../state/midiBus';
import type { NoteExpression, PianoNote, RollControl, RollPartRef } from '../state/pianoRollStore';
import { PPQ } from './noteClock';
import { sanitizeNoteExpression, type ExpressionDimension } from './noteExpression';
import { MPE_MEMBER_BEND_RANGE } from './mpeMidi';
import { PERCUSSION_PART_CHANNEL, cleanPartControls, partController } from './rollTracks';
import { takeToRoll } from './takeNotes';

/* -------------------------------------------------------------------------- */
/*                                  parsing                                   */
/* -------------------------------------------------------------------------- */

/** What a channel-voice message is, as far as capture cares. */
export type MidiMessageKind = 'noteOn' | 'noteOff' | 'cc' | 'other';

export interface ParsedMidiMessage {
  kind: MidiMessageKind;
  /** 0-15. System messages (status >= 0xf0) report 0. */
  channel: number;
  /** Note number for note messages, controller number for `cc`, else 0. */
  note: number;
  /** Data byte 2: velocity for note messages, value for `cc`, else 0. */
  velocity: number;
}

const OTHER: ParsedMidiMessage = { kind: 'other', channel: 0, note: 0, velocity: 0 };

/**
 * Decode one Web MIDI message.
 *
 * Running status is deliberately not handled: `MIDIMessageEvent.data` always
 * carries a complete message with its status byte (Web MIDI API, "MIDI
 * messages" — the UA reassembles the stream), so a byte under 0x80 in position
 * 0 is not a continuation here, it is garbage.
 *
 * A note-on with velocity 0 IS a note-off — the convention every controller
 * that uses running status relies on — so it is reported as one.
 */
export function parseMidiMessage(data: readonly number[] | Uint8Array): ParsedMidiMessage {
  const status = Number(data[0] ?? 0) | 0;
  if (status < 0x80 || status >= 0xf0) return OTHER;
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const note = Number(data[1] ?? 0) | 0;
  const velocity = Number(data[2] ?? 0) | 0;
  if (command === 0x90) return { kind: velocity > 0 ? 'noteOn' : 'noteOff', channel, note, velocity };
  if (command === 0x80) return { kind: 'noteOff', channel, note, velocity };
  if (command === 0xb0) return { kind: 'cc', channel, note, velocity };
  return { kind: 'other', channel, note, velocity };
}

/* -------------------------------------------------------------------------- */
/*                               note capture                                 */
/* -------------------------------------------------------------------------- */

/** One played note, in TRANSPORT seconds. */
export interface CapturedNote {
  /** MIDI note number 0-127. */
  note: number;
  /** Velocity 1-127, as struck. */
  velocity: number;
  startSec: number;
  endSec: number;
  /** The channel it was played on, when not channel 1 (0). */
  channel?: number;
  /** Its channel's pressure, CC 74 and wheel where it started and while it sounded; absent when its channel sent none. */
  expr?: CapturedExpression;
}

/** A held note's channel expression: the values it started at (0..1, the bend -1..1) and each change, seconds from its start. */
export interface CapturedExpression {
  pressure?: number;
  timbre?: number;
  pitchBend?: number;
  changes: Array<{ sec: number; dim: ExpressionDimension; value: number }>;
}

/**
 * A channel pressure (D0), CC 74 or pitch wheel (E0) message as the note
 * expression it is on its channel: pressure and timbre 0..1, the bend -1..1.
 * Null for anything else.
 */
export function parseExpressionMessage(data: readonly number[] | Uint8Array): { dim: ExpressionDimension; channel: number; value: number } | null {
  const status = Number(data[0] ?? 0) | 0;
  if (status < 0x80 || status >= 0xf0) return null;
  const channel = status & 0x0f;
  const command = status & 0xf0;
  const d1 = Number(data[1] ?? 0) & 0x7f;
  const d2 = Number(data[2] ?? 0) & 0x7f;
  if (command === 0xd0) return { dim: 'pressure', channel, value: d1 / 127 };
  if (command === 0xb0 && d1 === 74) return { dim: 'timbre', channel, value: d2 / 127 };
  if (command === 0xe0) {
    const raw = d1 | (d2 << 7);
    return { dim: 'pitchBend', channel, value: (raw - 8192) / (raw >= 8192 ? 8191 : 8192) };
  }
  return null;
}

/** One controller change played, in TRANSPORT seconds: a controller a roll part keeps. */
export interface CapturedControl {
  controller: number;
  /** 0-127. */
  value: number;
  sec: number;
}

export interface NoteCapture {
  /** Begin (or restart) a pass. Messages arriving while closed are ignored. */
  open: () => void;
  /** Feed one bus message. */
  onMessage: (msg: MidiBusMessage | readonly number[]) => void;
  /** End the pass, closing every still-held note at `now()`. Returns the notes
   *  in play order and empties the capture; a second call returns nothing. */
  close: () => CapturedNote[];
  /** How many notes are held down right now. */
  pending: () => number;
  /** The controller changes of the pass `close` ended, in play order (lib/rollTracks PART_CONTROLLERS only). A second call returns nothing. */
  takeControls: () => CapturedControl[];
}

/** A note held down, keyed by `(channel << 8) | note` so two channels playing
 *  the same pitch are two notes, not one stuck one. */
interface HeldNote {
  note: number;
  velocity: number;
  startSec: number;
  channel: number;
  expr?: CapturedExpression;
}

/**
 * A pass recorder for ONE track. `now` is the transport clock —
 * `liveMixer.currentTransportSec` in the app, a hand-advanced number in tests.
 */
export function createNoteCapture(opts: { now: () => number }): NoteCapture {
  const { now } = opts;
  const held = new Map<number, HeldNote>();
  let done: CapturedNote[] = [];
  let controls: CapturedControl[] = [];
  let closedControls: CapturedControl[] = [];
  let isOpen = false;
  // Each channel's pressure, CC 74 and wheel as last sent: what a note on it starts at.
  const channelState = new Map<number, Partial<Record<ExpressionDimension, number>>>();

  const finish = (key: number, endSec: number): void => {
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    done.push({
      note: h.note,
      velocity: h.velocity,
      startSec: h.startSec,
      endSec,
      ...(h.channel !== 0 ? { channel: h.channel } : {}),
      ...(h.expr ? { expr: h.expr } : {}),
    });
  };

  return {
    open: () => {
      held.clear();
      done = [];
      controls = [];
      closedControls = [];
      channelState.clear();
      isOpen = true;
    },
    onMessage: (msg) => {
      if (!isOpen) return;
      const data = Array.isArray(msg) || msg instanceof Uint8Array ? msg : (msg as MidiBusMessage).data;
      const expression = parseExpressionMessage(data as readonly number[]);
      if (expression) {
        // The channel's state for the next note, and a change of every note it holds now.
        const at = now();
        const state = channelState.get(expression.channel) ?? {};
        state[expression.dim] = expression.value;
        channelState.set(expression.channel, state);
        for (const h of held.values()) {
          if (h.channel !== expression.channel) continue;
          h.expr ??= { changes: [] };
          h.expr.changes.push({ sec: Math.max(0, at - h.startSec), dim: expression.dim, value: expression.value });
        }
      }
      const parsed = parseMidiMessage(data as readonly number[]);
      if (parsed.kind === 'cc') {
        // A controller a part keeps, at the transport second it arrived (the header's rule).
        if (partController(parsed.note)) controls.push({ controller: parsed.note, value: Math.max(0, Math.min(127, parsed.velocity)), sec: now() });
        return;
      }
      if (parsed.kind !== 'noteOn' && parsed.kind !== 'noteOff') return;
      // The transport second NOW, not `msg.t` — see the header.
      const at = now();
      const key = (parsed.channel << 8) | parsed.note;
      if (parsed.kind === 'noteOff') {
        finish(key, at);
        return;
      }
      // A second note-on for a pitch already down is a retrigger (some
      // controllers never send the off): close the old note, start a new one.
      finish(key, at);
      const state = channelState.get(parsed.channel);
      held.set(key, {
        note: parsed.note,
        velocity: Math.max(1, Math.min(127, parsed.velocity)),
        startSec: at,
        channel: parsed.channel,
        // Where its channel's pressure, CC 74 and wheel are as it starts (an MPE controller sends them just before).
        ...(state && Object.keys(state).length ? { expr: { ...state, changes: [] } } : {}),
      });
    },
    close: () => {
      if (!isOpen) return [];
      isOpen = false;
      // Anything still down when the pass ends stops at the pass's end, so a
      // note held through STOP is a note, not a silence.
      const at = now();
      for (const key of [...held.keys()]) finish(key, at);
      const out = done;
      done = [];
      closedControls = controls;
      controls = [];
      return out.sort((a, b) => a.startSec - b.startSec || a.note - b.note);
    },
    pending: () => held.size,
    takeControls: () => {
      const out = closedControls;
      closedControls = [];
      return out;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                   punch                                    */
/* -------------------------------------------------------------------------- */

/** The transport-second window a pass may write into. Mirrors the private
 *  `punchWindow()` in `state/recordingStore.ts`; an open edge is infinite. */
export interface PunchWindow {
  from: number;
  to: number;
}

/**
 * Crop notes to the punch window, the way `placeTakes` crops a take: the part
 * inside the window is kept, the part outside is trimmed off, and a note with
 * no sounding time inside is dropped entirely.
 *
 * A zero-length note (a tap whose on and off landed in the same transport
 * frame) INSIDE the window survives — `takeToRoll` gives it its one-tick
 * minimum. A note that merely grazes an edge does not: it has real length and
 * none of it is inside.
 */
export function cropNotesToWindow(
  notes: readonly CapturedNote[],
  win: PunchWindow | null,
): CapturedNote[] {
  if (!win) return [...notes];
  const out: CapturedNote[] = [];
  for (const n of notes) {
    const from = Math.max(n.startSec, win.from);
    const to = Math.min(n.endSec, win.to);
    if (to < from) continue;
    if (to === from && n.endSec > n.startSec) continue;
    // A note cut at its start keeps its expression from there on: the value each dimension had
    // at the cut is where it starts, then the changes after it.
    const cut = from - n.startSec;
    let expr = n.expr;
    if (n.expr && cut > 0) {
      const start: CapturedExpression = { changes: [] };
      if (n.expr.pressure !== undefined) start.pressure = n.expr.pressure;
      if (n.expr.timbre !== undefined) start.timbre = n.expr.timbre;
      if (n.expr.pitchBend !== undefined) start.pitchBend = n.expr.pitchBend;
      for (const c of n.expr.changes) if (c.sec <= cut) start[c.dim] = c.value;
      start.changes = n.expr.changes.filter((c) => c.sec > cut).map((c) => ({ ...c, sec: c.sec - cut }));
      expr = start;
    }
    out.push({
      note: n.note,
      velocity: n.velocity,
      startSec: from,
      endSec: to,
      ...(n.channel !== undefined ? { channel: n.channel } : {}),
      ...(expr ? { expr } : {}),
    });
  }
  return out;
}

/**
 * True when a pass is an MPE controller's, whose channels are its notes': its
 * notes (the drums' aside) sit on two or more channels, one note at a time on
 * each, and some channel carries pressure or CC 74, MPE's own dimensions. A
 * split or layered keyboard (a bass hand on one channel, the melody on
 * another, a wheel on the melody's) is not one: its wheel bends a channel at
 * that synth's own range, not a note at MPE's 48 semitones.
 */
export function isMpePass(notes: readonly CapturedNote[]): boolean {
  const byChannel = new Map<number, CapturedNote[]>();
  for (const n of notes) {
    const ch = n.channel ?? 0;
    if (ch === 9) continue;
    const list = byChannel.get(ch);
    if (list) list.push(n);
    else byChannel.set(ch, [n]);
  }
  if (byChannel.size < 2) return false;
  for (const list of byChannel.values()) {
    const sorted = [...list].sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < sorted.length; i += 1) if (sorted[i].startSec < sorted[i - 1].endSec - 1e-6) return false;
  }
  return [...byChannel.values()].some((list) =>
    list.some((n) => n.expr && (n.expr.pressure !== undefined || n.expr.timbre !== undefined || n.expr.changes.some((c) => c.dim !== 'pitchBend'))),
  );
}

/**
 * A captured note's expression as the roll's (PianoNote `expr`): its start
 * values and each change as a curve point at its tick from the note's start
 * (960 to the quarter at `bpm`), the bend at MPE's 48 semitones. Undefined
 * when it has none.
 */
export function capturedExpression(e: CapturedExpression | undefined, bpm: number): NoteExpression | undefined {
  if (!e) return undefined;
  const ticksPerSec = ((Number.isFinite(bpm) && bpm > 0 ? bpm : 120) / 60) * PPQ;
  const curves: NonNullable<NoteExpression['curves']> = {};
  for (const c of e.changes) {
    const tick = Math.round(c.sec * ticksPerSec);
    if (tick <= 0) continue;
    (curves[c.dim] ??= []).push({ tick, value: c.value });
  }
  // A change at the note's start is its start value.
  const start: Partial<Record<ExpressionDimension, number>> = { pressure: e.pressure, timbre: e.timbre, pitchBend: e.pitchBend };
  for (const c of e.changes) if (Math.round(c.sec * ticksPerSec) <= 0) start[c.dim] = c.value;
  return sanitizeNoteExpression({
    ...start,
    ...(start.pitchBend !== undefined || curves.pitchBend ? { bendRange: MPE_MEMBER_BEND_RANGE } : {}),
    curves,
  });
}

/**
 * A pass's controller changes as a take's roll part controls: each inside the
 * punch window (an open window keeps all), at its tick from the clip's start
 * (`originSec`) at 960 to the quarter at `bpm`, the way takeToRoll places a
 * note, cleaned as every part's controls are (lib/rollTracks
 * cleanPartControls). Undefined when none is left.
 */
export function capturedControlsToRoll(
  controls: readonly CapturedControl[],
  opts: { bpm: number; originSec: number; window?: PunchWindow | null },
): RollControl[] | undefined {
  const bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : 120;
  const ticksPerSec = (bpm / 60) * PPQ;
  const win = opts.window ?? null;
  const kept = controls.filter((c) => !win || (c.sec >= win.from && c.sec <= win.to));
  return cleanPartControls(
    kept.map((c) => ({ tick: Math.max(0, Math.round((c.sec - opts.originSec) * ticksPerSec)), controller: c.controller, value: c.value })),
  );
}

/** The roll part a take with controller changes carries (AudioClip `sourceRollPart`): a document of its own, one part. */
export function takePartRef(opts: {
  takeId: string;
  name: string;
  color: string;
  program?: number;
  percussion?: boolean;
  controls: RollControl[];
}): RollPartRef {
  return {
    doc: `take-${opts.takeId}`,
    id: `take-part-${opts.takeId}`,
    order: 0,
    name: opts.name,
    program: opts.program ?? null,
    bank: 0,
    channel: opts.percussion ? PERCUSSION_PART_CHANNEL : null,
    color: opts.color,
    mute: false,
    solo: false,
    controls: opts.controls,
  };
}

/* -------------------------------------------------------------------------- */
/*                            seconds -> roll steps                           */
/* -------------------------------------------------------------------------- */

// A pass becomes notes through `lib/takeNotes.takeToRoll`, the converter every
// take shares: each edge at the tick it was played on (960 to the quarter at
// the project BPM, relative to the clip's start), nothing quantised, at least
// one tick long. Snapping each edge to the nearest 16th with a one-step floor
// took a played part's timing away on the way in; quantising a take is the
// roll's APPLY, a step the player chooses.

/**
 * Steps per beat on the piano roll's grid. A step is a 16th note and a beat is
 * a quarter everywhere in the app, so this is 4 — the same divisor
 * `midiSynth.renderStepNotesToBlob` uses (`60 / bpm / 4`). Not a new tempo
 * owner: the BPM is handed in.
 */
export const STEPS_PER_BEAT = 4;

/** Seconds one step lasts at `bpm`. */
export function stepSeconds(bpm: number, stepsPerBeat: number = STEPS_PER_BEAT): number {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  return 60 / safeBpm / Math.max(1, Math.round(stepsPerBeat));
}

/* -------------------------------------------------------------------------- */
/*                             the armed-track rule                           */
/* -------------------------------------------------------------------------- */

/** What the runtime needs to know about a clip to judge the track it is on. */
export type CaptureClip = Pick<AudioClip, 'trackId' | 'startSec' | 'sourceKind' | 'sourcePianoRoll'>;

/** What the runtime needs to know about a track. */
export type CaptureTrack = Pick<EditorTrack, 'id' | 'color' | 'instrumentProgram' | 'isPercussion'>;

/** A MIDI clip = a piano-roll clip carrying its editable notes. The predicate
 *  `state/liveMixer.ts` schedules by (it is private there, so it is restated
 *  rather than imported; the three terms are the same three). */
export function isMidiCaptureClip(clip: CaptureClip): boolean {
  return clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll && clip.sourcePianoRoll.length > 0;
}

/**
 * Does an armed track capture MIDI on this pass?
 *
 * THE RULE: yes when the track declares an instrument (`instrumentProgram` is
 * set), is a drum track (`isPercussion`), or when its LATEST clip is a MIDI clip. No otherwise — including a track
 * with no clips at all, which is indistinguishable from a fresh audio track. A
 * track becomes a MIDI track the moment it has an instrument or a MIDI clip on
 * it, both of which are things the user did on purpose.
 *
 * ONE DEFINITION, TWO RECORDERS
 * ----------------------------
 * `state/recordingStore.ts` arms the take engine only for tracks this predicate
 * REJECTS (`micArmedIds`, batch 9 T26): an armed instrument track is the MIDI
 * capture's alone, an armed audio track is the mic engine's alone, and one
 * press never lands two takes on one track. The store's `armedTrackIds` stays
 * the full armed list (the RECORD key counts it and `openPass` picks its tracks
 * out of it); only the engine's arm list is filtered. `capturesMidi` is exported
 * for exactly that — both sides read ONE definition of "this is a MIDI track"
 * and cannot disagree. When every armed track captures MIDI the store starts
 * no mic engine but keeps the press contract byte-identical
 * (`recording` → `stopping` → `idle`), which is what `onStatus` opens and
 * closes on.
 */
export function capturesMidi(track: CaptureTrack, clips: readonly CaptureClip[]): boolean {
  if (track.instrumentProgram !== undefined || track.isPercussion === true) return true;
  let latest: CaptureClip | null = null;
  for (const c of clips) {
    if (c.trackId !== track.id) continue;
    if (!latest || c.startSec > latest.startSec) latest = c;
  }
  return latest ? isMidiCaptureClip(latest) : false;
}

/* -------------------------------------------------------------------------- */
/*                                 the runtime                                */
/* -------------------------------------------------------------------------- */

/** Posted when a pass ran with a MIDI track armed and nothing was played. */
export const NO_MIDI_MESSAGE = 'RECORD: no MIDI received';

/** Posted when notes WERE played but the punch window kept none of them — the
 *  MIDI counterpart of `recordingStore`'s `PUNCH_EMPTY_MESSAGE`. Saying "no
 *  MIDI received" here would be untrue. */
export const PUNCH_EMPTY_MIDI_MESSAGE = 'RECORD: no MIDI inside the punch window';

/** Peak bins per landed clip — `recordingStore`'s `TAKE_PEAK_BINS`. */
const CAPTURE_PEAK_BINS = 240;

/** The colour a clip falls back to when its track has none. */
const FALLBACK_CLIP_COLOR = '#8b5cf6';

/**
 * The placeholder a captured clip carries until its render lands.
 *
 * It has to be a REAL, decodable WAV rather than an empty Blob: WaveformEditor
 * decodes peaks for every clip that has none (its "Decode + cache peaks" effect
 * → `computePeaks` → `decodeAudioData`), and a zero-byte blob makes that throw
 * and log `Peak decode failed` on every single pass. 0.1 s of 44.1 kHz mono
 * silence, the same shape as WaveformEditor's own module-private
 * `silentWavBlob()` used by the MIDI-insert path (replicated because it is not
 * exported, and this module imports nothing at runtime by design). The clip
 * also lands with flat peaks, so the decode effect skips it outright.
 */
export function silentWavBlob(): Blob {
  const sampleRate = 44100;
  const channels = 1;
  const samples = Math.ceil(sampleRate * 0.1);
  const bytesPerSample = 2;
  const dataBytes = samples * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** A step note as `midiSynth.renderStepNotesToBlob` takes them. */
export interface StepRenderNote {
  note: number;
  velocity: number;
  step: number;
  length: number;
}

/** Everything the runtime reaches outside itself. No entry has a default: the
 *  one mount in `App.tsx` supplies them all, which is what keeps this module
 *  free of store imports (see the header). */
export interface MidiCaptureDeps {
  /** `midiBus.subscribeToMidi`. */
  subscribeMidi: (cb: (msg: MidiBusMessage) => void) => () => void;
  /** Any change to `useRecordingStore`. Returns an unsubscribe. */
  subscribeStatus: (cb: () => void) => () => void;
  /** `useRecordingStore.getState().status`. */
  status: () => string;
  /** `useRecordingStore.getState().armedTrackIds`. */
  armedTrackIds: () => readonly string[];
  /** The editor's tracks. */
  tracks: () => readonly CaptureTrack[];
  /** The editor's clips (all of them; the rule picks per track). */
  clips: () => readonly CaptureClip[];
  /** Transport seconds — `liveMixer.currentTransportSec`. */
  transportSec: () => number;
  /** The project BPM — `useEditorStore.getState().bpm`. */
  bpm: () => number;
  /** The punch window this pass may write into, or `null` for anywhere. */
  punchWindow: () => PunchWindow | null;
  /** The program a track with no `instrumentProgram` of its own falls back to —
   *  the soundfont picker's active program when soundfonts are on, else
   *  `undefined`. The last term of lib/clipProgram's `effectiveProgramFor`, which
   *  is what decides whether a fresh clip's bounce is already correct. */
  globalProgram: () => number | undefined;
  /** `soundfontEngine.ensureSoundfontReady` — warmed before a render so the
   *  first capture does not bounce through the fallback voice while the
   *  soundfont is still loading. Never rejects the landing if it fails. */
  ensureSoundfontReady: () => Promise<unknown>;
  /** `editorStore.beginUndoStep`. */
  beginUndoStep: () => void;
  /** `useEditorStore.getState().addClipToTrack`. */
  addClipToTrack: (clip: Omit<AudioClip, 'id'> & { id?: string }) => string;
  /** `useEditorStore.getState().applyClipRender` — history-exempt. */
  applyClipRender: (id: string, updates: Partial<AudioClip>, peaks?: Float32Array) => void;
  /** The clip with this id as the editor holds it now, read when its render
   *  lands so a take the user trimmed meanwhile keeps its window. */
  clipWindow: (id: string) => RenderWindowClip | undefined;
  /** `midiSynth.renderStepNotesToBlob`, taken in the MIDI render queue's turn
   *  (state/midiRenderQueue withRenderTurn) so it never overlaps another render. */
  renderStepNotes: (
    notes: StepRenderNote[],
    bpm: number,
    totalSteps: number,
    opts?: { program?: number; percussion?: boolean; controls?: readonly RollControl[] },
  ) => Promise<{ blob: Blob; duration: number }>;
  /** `lib/midiRender.midiRenderSig`: what a take's render was made from, so a
   *  later note edit marks it stale and EDIT renders it again. Left out, the
   *  render carries no signature and is trusted for its notes. */
  renderSig?: (take: Pick<AudioClip, 'sourceKind' | 'sourcePianoRoll' | 'sourceRollNotes' | 'sourceBpm' | 'sourceTotalSteps'>) => string;
  /** `editorStore.computePeaks`. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array; duration: number }>;
  /** `statusNoticeStore.postStatus`. */
  postStatus: (text: string) => void;
}

/** One armed MIDI track's open capture. */
interface OpenCapture {
  trackId: string;
  capture: NoteCapture;
  /** Transport second the pass opened at, before any punch crop. */
  openedAt: number;
  program?: number;
  /** The track is a drum track: the take renders on the drum channel. */
  percussion?: boolean;
  color?: string;
}

/** Take numbering across the session, as `recordingStore`'s `takeSeq` is. */
let takeSeq = 0;

/** Reset the take counter. Tests only. */
export function resetMidiTakeSeq(): void {
  takeSeq = 0;
}

/**
 * Mount the capture. Subscribes the MIDI bus and the recording store, opens a
 * capture per armed MIDI track when a pass starts, and lands the pass when it
 * ends. Returns the disposer.
 *
 * Every open capture sees the WHOLE bus — the app has no per-track MIDI input
 * routing, so two armed MIDI tracks both record what was played. That is the
 * honest reading of "armed" with one input stream.
 */
export function startMidiCapture(deps: MidiCaptureDeps): () => void {
  let open: OpenCapture[] = [];
  let passWindow: PunchWindow | null = null;
  let prevStatus = deps.status();

  const openPass = (): void => {
    const armed = new Set(deps.armedTrackIds());
    if (armed.size === 0) return;
    const clips = deps.clips();
    const at = deps.transportSec();
    // Frozen for the whole pass, exactly as `recordingStore` freezes its own:
    // a punch mode changed mid-pass cannot desync what lands.
    passWindow = deps.punchWindow();
    for (const track of deps.tracks()) {
      if (!armed.has(track.id)) continue;
      if (!capturesMidi(track, clips)) continue;
      const capture = createNoteCapture({ now: deps.transportSec });
      capture.open();
      open.push({
        trackId: track.id,
        capture,
        openedAt: at,
        program: track.instrumentProgram,
        percussion: track.isPercussion === true,
        color: track.color,
      });
    }
  };

  const closePass = (): void => {
    const passes = open;
    open = [];
    const win = passWindow;
    passWindow = null;
    if (passes.length === 0) return;

    // Gather first, write second: the adds have to be synchronous and
    // contiguous to fold into ONE undo step.
    const landing: Array<{
      pass: OpenCapture;
      rollNotes: PianoNote[];
      totalSteps: number;
      startSec: number;
      durationSec: number;
      /** The voice this clip's audio is rendered with, resolved the way
       *  lib/clipProgram `clipVoice` resolves it. */
      voice: ClipVoice;
      /** The controller changes played in the pass, on the clip's clock; absent when none. */
      controls?: RollControl[];
    }> = [];
    let played = 0;
    const bpm = deps.bpm();
    const globalProgram = deps.globalProgram();
    for (const pass of passes) {
      const raw = pass.capture.close();
      const playedControls = pass.capture.takeControls();
      played += raw.length;
      // The punch crop is DESTRUCTIVE here, and that is a divergence from the
      // audio recorder worth naming: `placeTakes` keeps the whole pass as the
      // clip's SOURCE and trims the clip to the window with `offsetIntoSource`,
      // so dragging the clip's edge back out recovers what was punched away. A
      // MIDI clip IS its note list, so the notes outside the window are simply
      // not written and `offsetIntoSource` stays 0. Nondestructive MIDI punch
      // (keep every note, mark the window) is a follow-up, not a change here.
      const notes = cropNotesToWindow(raw, win);
      if (notes.length === 0) continue;
      // The clip begins where the pass did, pushed forward if the punch window
      // opens later — the same origin `placeTakes` gives a cropped take.
      const startSec = win ? Math.max(pass.openedAt, win.from) : pass.openedAt;
      const { rollNotes, totalSteps } = takeToRoll(notes, { bpm, originSec: startSec, idPrefix: 'mc' });
      if (rollNotes.length === 0 || totalSteps <= 0) continue;
      // An MPE pass: each note takes its own channel's expression, and CC 74 was the notes', not the part's.
      const mpe = isMpePass(notes);
      if (mpe && rollNotes.length === notes.length) {
        rollNotes.forEach((n, i) => {
          const expr = capturedExpression(notes[i].expr, bpm);
          if (expr) n.expr = expr;
        });
      }
      const controls = capturedControlsToRoll(mpe ? playedControls.filter((c) => c.controller !== 74) : playedControls, { bpm, originSec: startSec, window: win });
      landing.push({
        ...(controls ? { controls } : {}),
        pass,
        rollNotes,
        totalSteps,
        startSec,
        durationSec: totalSteps * stepSeconds(bpm),
        // Resolved BEFORE the add, the way `effectiveProgramFor` will resolve
        // it for this clip: the track's own program, else the global picker's.
        // A take with a program plays live and is not rendered; without the
        // global fallback a take on a track with no instrument of its own would
        // be rendered although the picker plays it live.
        voice: clipVoice(
          { instrumentProgram: pass.program },
          { isPercussion: pass.percussion },
          { useSoundfont: globalProgram !== undefined, activeProgram: globalProgram ?? 0 },
        ),
      });
    }

    if (landing.length === 0) {
      deps.postStatus(played > 0 ? PUNCH_EMPTY_MIDI_MESSAGE : NO_MIDI_MESSAGE);
      return;
    }

    deps.beginUndoStep();
    const rendered: Array<{ clipId: string; land: (typeof landing)[number] }> = [];
    for (const land of landing) {
      takeSeq += 1;
      // A take with a program plays live on EDIT's synths and renders when an
      // export needs it (lib/midiRender): it lands with no audio of its own and
      // nothing is rendered. A take with none cannot play live, so its audio is
      // rendered below.
      const playsLive = land.voice.program !== undefined;
      const clipId = deps.addClipToTrack({
        trackId: land.pass.trackId,
        label: `MIDI take ${takeSeq}`,
        // The audio of a take with no program is rendered below and applied
        // through the history-exempt `applyClipRender`, so the pass stays one
        // undo step however long the render takes. The placeholder it carries
        // meanwhile is a real decodable WAV and ships flat peaks, so
        // WaveformEditor's decode-peaks effect has nothing to fail on. Both are
        // audio the take holds only so it can be heard (AudioClip renderAuto),
        // so EDIT drops them once the take plays live.
        ...(playsLive ? {} : { audioBlob: silentWavBlob(), peaks: new Float32Array(CAPTURE_PEAK_BINS), renderAuto: true }),
        mimeType: 'audio/wav',
        sourceDuration: land.durationSec,
        offsetIntoSource: 0,
        durationSec: land.durationSec,
        startSec: land.startSec,
        color: land.pass.color ?? FALLBACK_CLIP_COLOR,
        sourceKind: 'piano-roll',
        // No lanes and no bends on a capture, so the roll's own notes and the
        // notes as they sound are the same list (two copies, never shared).
        sourcePianoRoll: land.rollNotes.map((n) => ({ ...n })),
        sourceRollNotes: land.rollNotes.map((n) => ({ ...n })),
        sourceBpm: bpm,
        sourceTotalSteps: land.totalSteps,
        // The TRACK's own program, not the resolved one: pinning the global
        // picker's program onto the clip would stop it following that picker
        // later. `effectiveProgramFor` falls back to the picker on its own, and
        // `renderedProgram` below records what the bounce actually used.
        ...(land.pass.program !== undefined ? { instrumentProgram: land.pass.program } : {}),
        // The controllers played with the notes, as the take's roll part carries them.
        ...(land.controls
          ? {
              sourceRollPart: takePartRef({
                takeId: String(takeSeq),
                name: `MIDI take ${takeSeq}`,
                color: land.pass.color ?? FALLBACK_CLIP_COLOR,
                program: land.pass.program,
                percussion: land.pass.percussion,
                controls: land.controls,
              }),
            }
          : {}),
      });
      if (!playsLive) rendered.push({ clipId, land });
    }

    for (const { clipId, land } of rendered) {
      void (async () => {
        // Warm the soundfont first, as WaveformEditor's re-bounce does: without
        // it the first capture of a session renders through the fallback voice
        // while the instrument is still loading, and is then re-rendered.
        try {
          await deps.ensureSoundfontReady();
        } catch {
          /* the built-in voice renders it; a warm-up failure is not a lost take */
        }
        const { blob, duration } = await deps.renderStepNotes(
          land.rollNotes.map((n) => ({ note: n.note, velocity: n.velocity, step: n.step, length: n.length })),
          bpm,
          land.totalSteps,
          {
            ...(land.voice.program !== undefined ? { program: land.voice.program, percussion: land.voice.percussion } : {}),
            // The controllers played with it, as its live playback sends them.
            ...(land.controls ? { controls: land.controls } : {}),
          },
        );
        let peaks: Float32Array | undefined;
        try {
          peaks = (await deps.computePeaks(blob, CAPTURE_PEAK_BINS)).peaks;
        } catch {
          /* a clip that draws flat is still a clip; the notes are on it */
        }
        // The render rings out past the last note-off, so an untrimmed take
        // grows to hold the release and export plays what live playback does.
        const now = deps.clipWindow(clipId);
        deps.applyClipRender(
          clipId,
          {
            audioBlob: blob,
            mimeType: 'audio/wav',
            ...(now ? renderedWindowFields(now, duration) : { sourceDuration: duration }),
            // What the blob actually contains, so WaveformEditor's
            // instrument-sync pass does not immediately re-render it. This is
            // the RESOLVED program (track's own, else the global picker's) —
            // the same value `effectiveProgramFor` reports for this clip.
            ...(land.voice.program !== undefined ? renderedVoiceFields(land.voice) : {}),
            // The notes it was made from, as the take landed with them, so a
            // later note edit marks it stale; and the reason it is held: the
            // take cannot play live, so it goes once the take can.
            ...(deps.renderSig
              ? {
                  renderSig: deps.renderSig({
                    sourceKind: 'piano-roll',
                    sourcePianoRoll: land.rollNotes,
                    sourceRollNotes: land.rollNotes,
                    sourceBpm: bpm,
                    sourceTotalSteps: land.totalSteps,
                  }),
                }
              : {}),
            renderAuto: true,
          },
          peaks,
        );
      })().catch(() => {
        /* The clip and its notes are already on the timeline; only its audio
           is missing. The silent placeholder goes, so EDIT's MIDI render queue
           (state/midiRenderQueue) sees a clip that cannot play live and holds
           no render, renders it again, and says why if that fails too. */
        deps.applyClipRender(clipId, { audioBlob: undefined, peaks: undefined });
      });
    }
  };

  const onStatus = (): void => {
    const next = deps.status();
    if (next === prevStatus) return;
    const was = prevStatus;
    prevStatus = next;
    if (next === 'recording' && was !== 'recording') openPass();
    else if (was === 'recording' && next !== 'recording') closePass();
  };

  const offMidi = deps.subscribeMidi((msg) => {
    for (const pass of open) pass.capture.onMessage(msg);
  });
  // A pass already running when the mount happens is NOT adopted: the second it
  // opened at is gone, so anything captured now would be misplaced. `prevStatus`
  // was seeded from the store above, so the next flip seen is the next pass.
  const offStatus = deps.subscribeStatus(onStatus);

  return () => {
    offMidi();
    offStatus();
    for (const pass of open) pass.capture.close();
    open = [];
    passWindow = null;
  };
}
