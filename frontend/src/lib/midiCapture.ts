/**
 * midiCapture — live MIDI input recorded onto the armed MIDI track, anchored to
 * TRANSPORT time.
 *
 * Why this exists
 * ---------------
 * `state/midiBus.ts` carries every inbound message, but nothing on the bus ever
 * kept one: the two readers are `publishMidi`'s subscribers (VJ forwarder, the
 * MidiMapper popups) and `lib/pianoTrigger.triggerPianoNoteFromMidi`, a 0.18 s
 * preview voice. Pressing RECORD with a controller plugged in armed the mic and
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
 * mount in `App.tsx`. The one runtime import is `lib/takeNotes`, a pure module
 * whose only import is `lib/noteClock`, which has none; the rest are `import
 * type`, erased at compile. So the core is testable under plain `tsx` with no
 * DOM, no store graph and — the point — no real MIDI device.
 *
 * Design source
 * -------------
 * theDAW's own `state/recordingStore.ts` (`placeTakes`, and its private
 * `punchWindow`) is the precedent this follows for landing a pass: ONE
 * `beginUndoStep()` for the whole pass, the clip added synchronously, and the
 * rendered audio applied afterwards through the history-exempt
 * `applyClipRender`. No reference DAW under `oss-refs/` was opened while
 * writing this file and no code is copied from one.
 */

import type { AudioClip, EditorTrack } from '../state/editorStore';
import type { MidiBusMessage } from '../state/midiBus';
import type { PianoNote } from '../state/pianoRollStore';
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
}

/** A note held down, keyed by `(channel << 8) | note` so two channels playing
 *  the same pitch are two notes, not one stuck one. */
interface HeldNote {
  note: number;
  velocity: number;
  startSec: number;
}

/**
 * A pass recorder for ONE track. `now` is the transport clock —
 * `liveMixer.currentTransportSec` in the app, a hand-advanced number in tests.
 */
export function createNoteCapture(opts: { now: () => number }): NoteCapture {
  const { now } = opts;
  const held = new Map<number, HeldNote>();
  let done: CapturedNote[] = [];
  let isOpen = false;

  const finish = (key: number, endSec: number): void => {
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    done.push({ note: h.note, velocity: h.velocity, startSec: h.startSec, endSec });
  };

  return {
    open: () => {
      held.clear();
      done = [];
      isOpen = true;
    },
    onMessage: (msg) => {
      if (!isOpen) return;
      const data = Array.isArray(msg) || msg instanceof Uint8Array ? msg : (msg as MidiBusMessage).data;
      const parsed = parseMidiMessage(data as readonly number[]);
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
      held.set(key, { note: parsed.note, velocity: Math.max(1, Math.min(127, parsed.velocity)), startSec: at });
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
      return out.sort((a, b) => a.startSec - b.startSec || a.note - b.note);
    },
    pending: () => held.size,
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
    out.push({ note: n.note, velocity: n.velocity, startSec: from, endSec: to });
  }
  return out;
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
export type CaptureTrack = Pick<EditorTrack, 'id' | 'color' | 'instrumentProgram'>;

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
 * set) or when its LATEST clip is a MIDI clip. No otherwise — including a track
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
  if (track.instrumentProgram !== undefined) return true;
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
   *  `undefined`. The last term of WaveformEditor's `effectiveProgramFor`, which
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
  /** `midiSynth.renderStepNotesToBlob`. */
  renderStepNotes: (
    notes: StepRenderNote[],
    bpm: number,
    totalSteps: number,
    opts?: { program?: number },
  ) => Promise<{ blob: Blob; duration: number }>;
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
      /** The program this clip's audio is rendered with, resolved the way
       *  WaveformEditor's `effectiveProgramFor` resolves it. */
      program: number | undefined;
    }> = [];
    let played = 0;
    const bpm = deps.bpm();
    const globalProgram = deps.globalProgram();
    for (const pass of passes) {
      const raw = pass.capture.close();
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
      landing.push({
        pass,
        rollNotes,
        totalSteps,
        startSec,
        durationSec: totalSteps * stepSeconds(bpm),
        // Resolved BEFORE the add, so `renderedProgram` below is already what
        // `effectiveProgramFor` will compute for this clip and WaveformEditor's
        // instrument-sync effect has nothing to re-render. Without the global
        // fallback a track with no instrument of its own lands a clip whose
        // effective program is the soundfont's, is stamped with nothing, and is
        // therefore re-bounced the instant it appears.
        program: pass.program ?? globalProgram,
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
      const clipId = deps.addClipToTrack({
        trackId: land.pass.trackId,
        label: `MIDI take ${takeSeq}`,
        // The audio is rendered below and applied through the history-exempt
        // `applyClipRender`, so the pass stays one undo step however long the
        // render takes. Until it lands the clip plays from `sourcePianoRoll`,
        // which the live scheduler synthesises directly. The placeholder is a
        // real decodable WAV and ships flat peaks, so WaveformEditor's
        // decode-peaks effect has nothing to fail on in the meantime.
        audioBlob: silentWavBlob(),
        mimeType: 'audio/wav',
        peaks: new Float32Array(CAPTURE_PEAK_BINS),
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
      });
      rendered.push({ clipId, land });
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
          land.program !== undefined ? { program: land.program } : {},
        );
        let peaks: Float32Array | undefined;
        try {
          peaks = (await deps.computePeaks(blob, CAPTURE_PEAK_BINS)).peaks;
        } catch {
          /* a clip that draws flat is still a clip; the notes are on it */
        }
        deps.applyClipRender(
          clipId,
          {
            audioBlob: blob,
            mimeType: 'audio/wav',
            sourceDuration: duration,
            // What the blob actually contains, so WaveformEditor's
            // instrument-sync pass does not immediately re-render it. This is
            // the RESOLVED program (track's own, else the global picker's) —
            // the same value `effectiveProgramFor` reports for this clip.
            ...(land.program !== undefined ? { renderedProgram: land.program } : {}),
          },
          peaks,
        );
      })().catch(() => {
        /* the clip and its notes are already on the timeline; only the
           pre-rendered audio is missing, and live playback synthesises it */
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
