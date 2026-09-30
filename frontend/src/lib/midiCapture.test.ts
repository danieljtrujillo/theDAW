/**
 * midiCapture — driven entirely by fakes: a hand-advanced transport clock, a
 * fake MIDI bus the test publishes onto by hand, fake recording/editor stores,
 * and a fake step-note renderer. No MIDI device is opened, no DOM is required
 * and no store is imported.
 *
 * The load-bearing assertions are:
 *   - a note is stamped with the TRANSPORT second at message time, so the clock
 *     is advanced between the note-on and the note-off and the note has to span
 *     the difference;
 *   - a note-on with velocity 0 is a note-off (and a note held through STOP is
 *     still a note);
 *   - a pass lands at the ticks it was played on, not snapped to 16ths;
 *   - an armed AUDIO track captures nothing — the mic engine keeps it.
 */
import assert from 'node:assert/strict';
import {
  NO_MIDI_MESSAGE,
  PUNCH_EMPTY_MIDI_MESSAGE,
  STEPS_PER_BEAT,
  capturedControlsToRoll,
  capturesMidi,
  parseExpressionMessage,
  createNoteCapture,
  cropNotesToWindow,
  isMidiCaptureClip,
  isMpePass,
  parseMidiMessage,
  resetMidiTakeSeq,
  silentWavBlob,
  startMidiCapture,
  stepSeconds,
  type CaptureClip,
  type CaptureTrack,
  type CapturedNote,
  type MidiCaptureDeps,
  type StepRenderNote,
} from './midiCapture.ts';
import type { AudioClip } from '../state/editorStore.ts';
import type { MidiBusMessage } from '../state/midiBus.ts';

const near = (a: number, b: number, msg: string): void => {
  assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`);
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/* --------------------------------- parsing -------------------------------- */
{
  assert.deepEqual(parseMidiMessage([0x90, 60, 100]), {
    kind: 'noteOn',
    channel: 0,
    note: 60,
    velocity: 100,
  });
  // Velocity 0 on a note-on IS a note-off. The whole point of this branch.
  assert.equal(parseMidiMessage([0x90, 60, 0]).kind, 'noteOff', 'note-on velocity 0 is a note-off');
  assert.equal(parseMidiMessage([0x80, 60, 64]).kind, 'noteOff');
  // Running channels: the low nibble is the channel on every command.
  for (let ch = 0; ch < 16; ch += 1) {
    const on = parseMidiMessage([0x90 | ch, 48 + ch, 7]);
    assert.equal(on.kind, 'noteOn', `channel ${ch} note-on`);
    assert.equal(on.channel, ch, `channel ${ch} decoded`);
    assert.equal(parseMidiMessage([0x80 | ch, 48 + ch, 0]).channel, ch, `channel ${ch} note-off`);
  }
  const cc = parseMidiMessage([0xb3, 74, 21]);
  assert.deepEqual(cc, { kind: 'cc', channel: 3, note: 74, velocity: 21 });
  // Program change / aftertouch / pitch bend are channel messages we do not act on.
  assert.equal(parseMidiMessage([0xc0, 42]).kind, 'other', 'program change is other');
  assert.equal(parseMidiMessage([0xe0, 0, 64]).kind, 'other', 'pitch bend is other');
  // System real-time (clock, start, stop) has no channel.
  assert.deepEqual(parseMidiMessage([0xf8]), { kind: 'other', channel: 0, note: 0, velocity: 0 });
  assert.deepEqual(parseMidiMessage([0xfa]), { kind: 'other', channel: 0, note: 0, velocity: 0 });
  // A data byte in position 0 is garbage here, not running status: Web MIDI
  // hands over complete messages.
  assert.equal(parseMidiMessage([60, 100]).kind, 'other', 'a headless message is not decoded');
  assert.equal(parseMidiMessage([]).kind, 'other', 'an empty message is survived');
  // Missing data bytes read as 0 rather than NaN.
  assert.deepEqual(parseMidiMessage([0x90]), { kind: 'noteOff', channel: 0, note: 0, velocity: 0 });
  // Uint8Array is what Web MIDI actually delivers.
  assert.equal(parseMidiMessage(new Uint8Array([0x91, 64, 90])).kind, 'noteOn');
  assert.equal(parseMidiMessage(new Uint8Array([0x91, 64, 90])).channel, 1);
}

/* ------------------------------ note capture ------------------------------ */
{
  // A note spans the transport seconds at its ON and its OFF — NOT the bus
  // message's own `t`, which is deliberately nonsense here.
  let sec = 0;
  const cap = createNoteCapture({ now: () => sec });
  cap.open();
  sec = 2.5;
  cap.onMessage({ data: [0x90, 60, 100], t: 999999 });
  assert.equal(cap.pending(), 1, 'the note is held');
  sec = 3.25;
  cap.onMessage({ data: [0x80, 60, 0], t: 111111 });
  assert.equal(cap.pending(), 0);
  const notes = cap.close();
  assert.equal(notes.length, 1);
  near(notes[0].startSec, 2.5, 'startSec is the transport second at the note-on');
  near(notes[0].endSec, 3.25, 'endSec is the transport second at the note-off');
  assert.equal(notes[0].velocity, 100);
  assert.deepEqual(cap.close(), [], 'a second close returns nothing');
}

{
  // The same pitch on two channels is two notes, not one stuck one.
  let sec = 0;
  const cap = createNoteCapture({ now: () => sec });
  cap.open();
  cap.onMessage([0x90, 60, 100]); // ch 0 on
  sec = 0.5;
  cap.onMessage([0x91, 60, 40]); // ch 1 on, SAME pitch
  assert.equal(cap.pending(), 2, 'per (channel, note), so both are held');
  sec = 1;
  cap.onMessage([0x81, 60, 0]); // ch 1 off
  assert.equal(cap.pending(), 1, 'the channel-0 note is still down');
  sec = 2;
  const notes = cap.close();
  assert.equal(notes.length, 2);
  near(notes[0].startSec, 0, 'channel 0 started first');
  near(notes[0].endSec, 2, 'a note held at close() ends at close()');
  near(notes[1].startSec, 0.5, 'channel 1 started later');
  near(notes[1].endSec, 1, 'and closed on its own note-off');
  assert.equal(notes[1].velocity, 40);
}

{
  // A velocity-0 note-on closes the note exactly as 0x80 does.
  let sec = 0;
  const cap = createNoteCapture({ now: () => sec });
  cap.open();
  cap.onMessage([0x90, 72, 88]);
  sec = 1.5;
  cap.onMessage([0x90, 72, 0]);
  assert.equal(cap.pending(), 0, 'velocity-0 note-on released the note');
  const notes = cap.close();
  assert.equal(notes.length, 1);
  near(notes[0].endSec, 1.5, 'and did so at that second');
}

{
  // Messages outside a pass are ignored; CC never becomes a note; a retrigger
  // without an intervening off closes the old note and starts a new one.
  let sec = 0;
  const cap = createNoteCapture({ now: () => sec });
  cap.onMessage([0x90, 60, 100]);
  assert.equal(cap.pending(), 0, 'a note before open() is not captured');
  cap.open();
  cap.onMessage([0xb0, 64, 127]);
  cap.onMessage([0xf8]);
  assert.equal(cap.pending(), 0, 'CC and clock are not notes');
  cap.onMessage([0x90, 55, 60]);
  sec = 1;
  cap.onMessage([0x90, 55, 90]); // retrigger, no off
  assert.equal(cap.pending(), 1, 'still one note down after a retrigger');
  sec = 2;
  const notes = cap.close();
  assert.equal(notes.length, 2, 'the retrigger split it into two notes');
  near(notes[0].endSec, 1, 'the first ends where the second begins');
  assert.equal(notes[1].velocity, 90);
  // A stray note-off for a pitch that was never down changes nothing.
  cap.open();
  cap.onMessage([0x80, 21, 0]);
  assert.deepEqual(cap.close(), [], 'an unmatched note-off is dropped');
}

/* --------------------------- seconds -> roll steps ------------------------- */
{
  // The conversion itself is lib/takeNotes (takeNotes.test.ts); a landed pass
  // below checks the capture hands it the clip's start and the project BPM.
  assert.equal(STEPS_PER_BEAT, 4, 'a step is a 16th — midiSynth renders 60/bpm/4');
  near(stepSeconds(120), 0.125, 'a 16th at 120 BPM');
  near(stepSeconds(90), 60 / 90 / 4, 'the divisor follows the BPM handed in');
}

/* ---------------------------------- punch --------------------------------- */
{
  const notes: CapturedNote[] = [
    { note: 60, velocity: 100, startSec: 0, endSec: 2 }, // straddles the in point
    { note: 62, velocity: 100, startSec: 3, endSec: 4 }, // wholly inside
    { note: 64, velocity: 100, startSec: 7, endSec: 9 }, // straddles the out point
    { note: 65, velocity: 100, startSec: 12, endSec: 13 }, // wholly after
    { note: 67, velocity: 100, startSec: 5, endSec: 5 }, // a tap inside
  ];
  assert.equal(cropNotesToWindow(notes, null).length, 5, 'no window keeps everything');
  const inOut = cropNotesToWindow(notes, { from: 1, to: 8 });
  assert.deepEqual(
    inOut.map((n) => [n.note, n.startSec, n.endSec]),
    [
      [60, 1, 2],
      [62, 3, 4],
      [64, 7, 8],
      [67, 5, 5],
    ],
    'the part inside is kept, the part outside trimmed, the one outside dropped',
  );
  // An open edge, as punch in / punch out give.
  const inOnly = cropNotesToWindow(notes, { from: 1, to: Infinity });
  assert.equal(inOnly.length, 5, 'punch in keeps everything after the in point');
  near(inOnly[0].startSec, 1, 'and still trims the straddling note');
  const outOnly = cropNotesToWindow(notes, { from: -Infinity, to: 8 });
  assert.equal(outOnly.length, 4, 'punch out drops what starts after the out point');
  // A note that only grazes an edge has no sounding time inside.
  assert.deepEqual(
    cropNotesToWindow([{ note: 60, velocity: 100, startSec: 0, endSec: 2 }], { from: 2, to: 5 }),
    [],
    'a note ending exactly at the in point is dropped',
  );
  assert.equal(
    cropNotesToWindow([{ note: 60, velocity: 100, startSec: 2, endSec: 2 }], { from: 2, to: 5 }).length,
    1,
    'but a zero-length tap AT the in point survives',
  );
}

/* ----------------------------- armed-track rule --------------------------- */
{
  const midiClip = (trackId: string, startSec: number): CaptureClip => ({
    trackId,
    startSec,
    sourceKind: 'piano-roll',
    sourcePianoRoll: [{ id: 'n', note: 60, step: 0, length: 1, velocity: 100 }],
  });
  const audioClip = (trackId: string, startSec: number): CaptureClip => ({
    trackId,
    startSec,
    sourceKind: 'audio',
  });
  assert.equal(isMidiCaptureClip(midiClip('t', 0)), true);
  assert.equal(isMidiCaptureClip(audioClip('t', 0)), false);
  assert.equal(
    isMidiCaptureClip({ trackId: 't', startSec: 0, sourceKind: 'piano-roll', sourcePianoRoll: [] }),
    false,
    'a piano-roll clip with no notes is not a MIDI clip',
  );

  const plain: CaptureTrack = { id: 't1', color: '#fff' };
  const instrument: CaptureTrack = { id: 't2', color: '#fff', instrumentProgram: 4 };
  assert.equal(capturesMidi(instrument, []), true, 'an instrument track captures, clips or not');
  assert.equal(capturesMidi(plain, []), false, 'an armed track with NO clips keeps the mic');
  assert.equal(capturesMidi(plain, [audioClip('t1', 0)]), false, 'an audio track keeps the mic');
  assert.equal(capturesMidi(plain, [midiClip('t1', 0)]), true, 'a track whose latest clip is MIDI captures');
  assert.equal(
    capturesMidi(plain, [midiClip('t1', 0), audioClip('t1', 10)]),
    false,
    'the LATEST clip decides, and it is audio',
  );
  assert.equal(
    capturesMidi(plain, [audioClip('t1', 0), midiClip('t1', 10)]),
    true,
    'the LATEST clip decides, and it is MIDI',
  );
  assert.equal(
    capturesMidi(plain, [midiClip('other', 99)]),
    false,
    "another track's clips do not decide this one",
  );
}

/* ---------------------------- placeholder audio --------------------------- */
{
  // The placeholder a captured clip carries until its render lands has to be a
  // REAL WAV: WaveformEditor decodes peaks for every clip that has none, and a
  // zero-byte blob makes that throw on every pass.
  const blob = silentWavBlob();
  assert.equal(blob.type, 'audio/wav');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const samples = Math.ceil(44100 * 0.1);
  assert.equal(bytes.length, 44 + samples * 2, '0.1 s of 44.1 kHz mono 16-bit + a 44-byte header');
  const tag = (off: number): string => String.fromCharCode(...bytes.slice(off, off + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(tag(36), 'data');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(4, true), 36 + samples * 2, 'the RIFF size covers the payload');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16, '16-bit');
  assert.equal(view.getUint32(40, true), samples * 2, 'the data chunk size matches the payload');
  assert.ok(bytes.slice(44).every((b) => b === 0), 'and it is silence');
}

/* --------------------------------- runtime -------------------------------- */

interface Harness {
  deps: MidiCaptureDeps;
  dispose: () => void;
  /** Move the transport. */
  sec: (s: number) => void;
  /** Flip the recording status and notify the subscriber. */
  setStatus: (s: string) => void;
  /** Publish onto the fake bus. */
  send: (data: number[]) => void;
  clips: Array<Omit<AudioClip, 'id'> & { id: string }>;
  renders: Array<{ id: string; updates: Partial<AudioClip>; peaks?: Float32Array }>;
  notices: string[];
  undoSteps: () => number;
  /** How many times the soundfont warm-up was awaited. */
  warmups: () => number;
  rendered: Array<{ notes: StepRenderNote[]; bpm: number; totalSteps: number; program?: number; percussion?: boolean }>;
  midiSubs: number;
}

const harness = (opts: {
  tracks: CaptureTrack[];
  existingClips?: CaptureClip[];
  armed: string[];
  bpm?: number;
  punch?: { from: number; to: number } | null;
  /** The soundfont picker's program, when soundfonts are on. */
  globalProgram?: number;
  /** Seconds the render rings past the take's nominal length, as a soundfont
   *  render of a held chord does. */
  ringSec?: number;
}): Harness => {
  let sec = 0;
  let status = 'idle';
  let undo = 0;
  let warmed = 0;
  const midiListeners = new Set<(m: MidiBusMessage) => void>();
  const statusListeners = new Set<() => void>();
  const clips: Array<Omit<AudioClip, 'id'> & { id: string }> = [];
  const renders: Array<{ id: string; updates: Partial<AudioClip>; peaks?: Float32Array }> = [];
  const notices: string[] = [];
  const rendered: Array<{ notes: StepRenderNote[]; bpm: number; totalSteps: number; program?: number; percussion?: boolean }> = [];
  let nextId = 0;

  const h: Harness = {
    deps: {
      subscribeMidi: (cb) => {
        midiListeners.add(cb);
        return () => midiListeners.delete(cb);
      },
      subscribeStatus: (cb) => {
        statusListeners.add(cb);
        return () => statusListeners.delete(cb);
      },
      status: () => status,
      armedTrackIds: () => opts.armed,
      tracks: () => opts.tracks,
      clips: () => opts.existingClips ?? [],
      transportSec: () => sec,
      bpm: () => opts.bpm ?? 120,
      punchWindow: () => opts.punch ?? null,
      globalProgram: () => opts.globalProgram,
      ensureSoundfontReady: async () => {
        warmed += 1;
        return true;
      },
      beginUndoStep: () => {
        undo += 1;
      },
      addClipToTrack: (clip) => {
        nextId += 1;
        const id = `clip-${nextId}`;
        clips.push({ ...clip, id });
        return id;
      },
      applyClipRender: (id, updates, peaks) => {
        renders.push({ id, updates, peaks });
      },
      clipWindow: (id) => clips.find((c) => c.id === id),
      renderStepNotes: async (notes, bpm, totalSteps, o) => {
        rendered.push({ notes, bpm, totalSteps, program: o?.program, percussion: o?.percussion });
        return { blob: new Blob(['wav'], { type: 'audio/wav' }), duration: totalSteps * stepSeconds(bpm) + (opts.ringSec ?? 0) };
      },
      computePeaks: async (_blob, bins) => ({ peaks: new Float32Array(bins ?? 0), duration: 1 }),
      postStatus: (text) => {
        notices.push(text);
      },
    },
    dispose: () => {},
    sec: (s) => {
      sec = s;
    },
    setStatus: (s) => {
      status = s;
      for (const cb of [...statusListeners]) cb();
    },
    send: (data) => {
      for (const cb of [...midiListeners]) cb({ data, t: 0 });
    },
    clips,
    renders,
    notices,
    undoSteps: () => undo,
    warmups: () => warmed,
    rendered,
    get midiSubs() {
      return midiListeners.size;
    },
  };
  h.dispose = startMidiCapture(h.deps);
  return h;
};

const MIDI_TRACK: CaptureTrack = { id: 'midi-1', color: '#7c3aed', instrumentProgram: 0 };
const AUDIO_TRACK: CaptureTrack = { id: 'aud-1', color: '#22d3ee' };
/** A MIDI track with no instrument of its own: its latest clip is a roll clip,
 *  so it captures, and with the picker off its takes have no program and
 *  cannot play live, so they are rendered. */
const PLAIN_MIDI_TRACK: CaptureTrack = { id: 'roll-0', color: '#f0f' };
const PLAIN_MIDI_CLIPS: CaptureClip[] = [
  { trackId: 'roll-0', startSec: 0, sourceKind: 'piano-roll', sourcePianoRoll: [{ id: 'n', note: 60, step: 0, length: 1, velocity: 90 }] },
];

{
  // A pass lands a MIDI clip on the armed instrument track at the transport
  // second the pass started, as ONE undo step. The track has an instrument, so
  // the take plays live on EDIT's synths: it lands with no audio of its own and
  // nothing is rendered (lib/midiRender: it renders when an export needs it).
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK, AUDIO_TRACK], armed: ['midi-1', 'aud-1'] });
  h.sec(8);
  h.setStatus('recording');
  h.sec(8.5);
  h.send([0x90, 60, 100]);
  h.sec(9);
  h.send([0x80, 60, 0]);
  h.sec(9.25);
  h.send([0x90, 67, 90]); // still held when the pass ends
  h.sec(9.75);
  h.setStatus('stopping');

  assert.equal(h.clips.length, 1, 'one clip — the armed AUDIO track captured nothing');
  const clip = h.clips[0];
  assert.equal(clip.trackId, 'midi-1');
  assert.equal(clip.label, 'MIDI take 1');
  near(clip.startSec, 8, 'the clip sits at the transport second the pass opened at');
  assert.equal(clip.sourceKind, 'piano-roll');
  assert.equal(clip.sourceBpm, 120);
  assert.equal(clip.instrumentProgram, 0);
  assert.equal(clip.offsetIntoSource, 0);
  assert.deepEqual(
    clip.sourceRollNotes?.map((n) => [n.note, n.step, n.length]),
    [
      [60, 4, 4], // 0.5 s in, 0.5 s long -> step 4, 4 steps
      [67, 10, 4], // 1.25 s in, held to 1.75 s
    ],
    'both notes, the held one closed at the pass end',
  );
  assert.deepEqual(
    clip.sourcePianoRoll?.map((n) => n.id),
    clip.sourceRollNotes?.map((n) => n.id),
    'the roll notes and the sounding notes are the same list',
  );
  assert.notEqual(clip.sourcePianoRoll, clip.sourceRollNotes, 'but two arrays, never shared');
  assert.equal(clip.sourceTotalSteps, 14);
  near(clip.durationSec, 14 * 0.125, 'the clip is as long as its grid');
  assert.equal(h.undoSteps(), 1, 'one undo step for the pass');
  assert.equal(clip.audioBlob, undefined, 'a take with an instrument lands with no audio of its own: it plays live');
  assert.equal(clip.peaks, undefined, 'and no placeholder peaks: its notes are what EDIT draws');
  assert.equal(clip.mimeType, 'audio/wav');

  await flush();
  assert.equal(h.warmups(), 0, 'nothing warms the soundfont for a render');
  assert.equal(h.rendered.length, 0, 'nothing is rendered');
  assert.equal(h.renders.length, 0, 'and nothing is applied');
  assert.deepEqual(h.notices, [], 'nothing to say about a pass that landed');
  h.dispose();
}

{
  // A take with no program cannot play live, so its audio is rendered after the
  // clip lands, applied through applyClipRender, and the clip carries a silent
  // placeholder meanwhile: a real WAV with peaks already on it, so
  // WaveformEditor's decode-peaks effect has nothing to fail on. Both are audio
  // held only so the take can be heard (renderAuto), which EDIT drops once the
  // take plays live, and the render records what it was made from (renderSig),
  // so a later note edit marks it stale. At 057f7499 the render carried
  // neither: it was kept after the take got an instrument, and a note edit
  // in the roll left it playing the old notes.
  resetMidiTakeSeq();
  const h = harness({ tracks: [PLAIN_MIDI_TRACK], existingClips: PLAIN_MIDI_CLIPS, armed: ['roll-0'] });
  const sigOf: Array<Record<string, unknown>> = [];
  h.deps.renderSig = (take) => {
    sigOf.push(take as Record<string, unknown>);
    return `sig:${take.sourcePianoRoll?.map((n) => n.note).join(',')}@${take.sourceBpm}/${take.sourceTotalSteps}`;
  };
  h.sec(8);
  h.setStatus('recording');
  h.sec(8.5);
  h.send([0x90, 60, 100]);
  h.sec(9);
  h.send([0x80, 60, 0]);
  h.sec(9.25);
  h.send([0x90, 67, 90]); // still held when the pass ends
  h.sec(9.75);
  h.setStatus('stopping');

  assert.equal(h.clips.length, 1);
  const clip = h.clips[0];
  assert.equal(clip.instrumentProgram, undefined);
  assert.ok(clip.audioBlob instanceof Blob && clip.audioBlob.size > 44, 'the placeholder is a real WAV, not a zero-byte blob');
  assert.equal(clip.mimeType, 'audio/wav');
  assert.equal(clip.peaks?.length, 240, 'and it ships flat peaks, so the decode effect skips it');
  assert.equal(clip.renderAuto, true, 'the placeholder is held only so the take can be heard');
  assert.equal(h.undoSteps(), 1, 'one undo step for the pass');

  await flush();
  assert.equal(h.warmups(), 1, 'the soundfont is warmed before the render');
  assert.equal(h.rendered.length, 1, 'the audio is rendered after the clip lands');
  assert.equal(h.rendered[0].totalSteps, 14);
  assert.equal(h.rendered[0].program, undefined, 'no program: the render is the voice it has');
  assert.deepEqual(
    h.rendered[0].notes.map((n) => [n.note, n.step, n.length]),
    [[60, 4, 4], [67, 10, 4]],
    'the render plays the notes as played',
  );
  assert.equal(h.renders.length, 1, 'and applied through applyClipRender');
  assert.equal(h.renders[0].id, clip.id);
  assert.ok(h.renders[0].updates.audioBlob instanceof Blob, 'with the rendered blob');
  assert.equal(h.renders[0].updates.renderedProgram, undefined, 'nothing to stamp');
  assert.equal(h.renders[0].peaks?.length, 240, 'and its peaks');
  assert.equal(h.renders[0].updates.renderAuto, true, 'made so the take can be heard');
  assert.equal(h.renders[0].updates.renderSig, 'sig:60,67@120/14', 'and what it was made from: the notes as they landed');
  assert.deepEqual(sigOf[0].sourcePianoRoll, clip.sourcePianoRoll, 'the signature reads the landed notes');
  h.dispose();
}

{
  // A take with no program whose render fails loses its silent placeholder, so
  // EDIT's MIDI render queue sees a clip that holds no audio and cannot play
  // live, renders it again, and says why if that fails too.
  resetMidiTakeSeq();
  const h = harness({ tracks: [PLAIN_MIDI_TRACK], existingClips: PLAIN_MIDI_CLIPS, armed: ['roll-0'] });
  h.deps.renderStepNotes = async () => { throw new Error('synth down'); };
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 60, 100]);
  h.sec(1);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  assert.ok(h.clips[0].audioBlob instanceof Blob, 'the placeholder rides until the render settles');
  await flush();
  assert.equal(h.renders.length, 1, 'one write when the render fails');
  assert.ok('audioBlob' in h.renders[0].updates && h.renders[0].updates.audioBlob === undefined, 'it takes the placeholder away');
  assert.ok('peaks' in h.renders[0].updates && h.renders[0].updates.peaks === undefined, 'and its flat peaks');
  h.dispose();
}

{
  // A pass played off the grid lands where it was played. At 100 BPM a tick is
  // 1/1600 s and a 16th is 0.15 s. Snapped to the nearest 16th with a one-step
  // floor (the capture's old conversion), the late note, the short one and the
  // tap all moved and the take lost its timing. Quantising is the roll's APPLY.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'], bpm: 100 });
  h.sec(10);
  h.setStatus('recording');
  h.sec(10.2); // 320 ticks in: a third of a 16th late
  h.send([0x90, 60, 100]);
  h.sec(10.25); // 400 ticks in, overlapping the first note
  h.send([0x90, 64, 90]);
  h.sec(10.29); // the first note is 144 ticks long, shorter than a 16th
  h.send([0x80, 60, 0]);
  h.sec(10.8);
  h.send([0x80, 64, 0]);
  h.sec(11); // a tap: on and off at one transport second
  h.send([0x90, 67, 70]);
  h.send([0x80, 67, 0]);
  h.sec(11.5);
  h.setStatus('stopping');

  assert.equal(h.clips.length, 1);
  const clip = h.clips[0];
  assert.deepEqual(
    clip.sourceRollNotes?.map((n) => [n.note, n.step, n.length]),
    [
      [60, 320 / 240, 144 / 240],
      [64, 400 / 240, 880 / 240],
      [67, 1600 / 240, 1 / 240],
    ],
    'each note at the 16th it was played on, fraction kept',
  );
  assert.deepEqual(
    clip.sourceRollNotes?.map((n) => [n.tick, n.ticks]),
    [
      [320, 144],
      [400, 880],
      [1600, 1],
    ],
    'and its ticks written with it, at least one tick long',
  );
  assert.deepEqual(clip.sourcePianoRoll, clip.sourceRollNotes, 'the sounding copy holds the same timing');
  assert.equal(clip.sourceTotalSteps, 7, 'the grid runs to the 16th after the last note ends');
  near(clip.durationSec, 7 * 0.15, 'and the clip is as long as its grid');
  await flush();
  // The track has an instrument, so these are the notes EDIT's live scheduler
  // plays; nothing is rendered until an export needs the audio.
  assert.equal(h.rendered.length, 0, 'a take that plays live is not rendered');
  h.dispose();
}

{
  // The same off-grid take on a track with no program is rendered, and the
  // render plays each note at the ticks it was played on.
  resetMidiTakeSeq();
  const h = harness({ tracks: [PLAIN_MIDI_TRACK], existingClips: PLAIN_MIDI_CLIPS, armed: ['roll-0'], bpm: 100 });
  h.sec(10);
  h.setStatus('recording');
  h.sec(10.2);
  h.send([0x90, 60, 100]);
  h.sec(10.25);
  h.send([0x90, 64, 90]);
  h.sec(10.29);
  h.send([0x80, 60, 0]);
  h.sec(10.8);
  h.send([0x80, 64, 0]);
  h.sec(11);
  h.send([0x90, 67, 70]);
  h.send([0x80, 67, 0]);
  h.sec(11.5);
  h.setStatus('stopping');
  await flush();
  assert.deepEqual(
    h.rendered[0].notes.map((n) => [n.note, n.step, n.length]),
    [
      [60, 320 / 240, 144 / 240],
      [64, 400 / 240, 880 / 240],
      [67, 1600 / 240, 1 / 240],
    ],
    'the bounce renders the notes as played',
  );
  h.dispose();
}

{
  // Nothing played: no clip, no undo step, one notice.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  h.sec(2);
  h.setStatus('recording');
  h.sec(5);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 0, 'an empty capture lands nothing');
  assert.equal(h.undoSteps(), 0, 'and does not open an undo step');
  assert.deepEqual(h.notices, [NO_MIDI_MESSAGE]);
  h.dispose();
}

{
  // An armed AUDIO-only track never opens a capture, so the bus goes nowhere
  // and the mic engine keeps the pass.
  resetMidiTakeSeq();
  const h = harness({ tracks: [AUDIO_TRACK], armed: ['aud-1'] });
  h.setStatus('recording');
  h.sec(1);
  h.send([0x90, 60, 100]);
  h.sec(2);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 0, 'an audio track captures no MIDI');
  assert.deepEqual(h.notices, [], 'and says nothing — this was never a MIDI pass');
  h.dispose();
}

{
  // A track whose latest clip is a MIDI clip captures without an instrument.
  resetMidiTakeSeq();
  const h = harness({
    tracks: [{ id: 'roll-1', color: '#f0f' }],
    existingClips: [
      {
        trackId: 'roll-1',
        startSec: 0,
        sourceKind: 'piano-roll',
        sourcePianoRoll: [{ id: 'n', note: 60, step: 0, length: 1, velocity: 90 }],
      },
    ],
    armed: ['roll-1'],
  });
  h.sec(0);
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 62, 77]);
  h.sec(1);
  h.send([0x90, 62, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 1, 'the MIDI track captured');
  assert.equal(h.clips[0].instrumentProgram, undefined, 'and carries no program it never had');
  await flush();
  assert.equal(h.rendered[0].program, undefined);
  assert.equal(h.renders[0].updates.renderedProgram, undefined, 'nothing to stamp');
  h.dispose();
}

{
  // A track with NO instrument of its own plays through the global picker's
  // program, the way `effectiveProgramFor` resolves it, so the take plays live
  // and is not rendered. The picker is not pinned onto the clip.
  resetMidiTakeSeq();
  const h = harness({
    tracks: [{ id: 'roll-2', color: '#f0f' }],
    existingClips: [
      {
        trackId: 'roll-2',
        startSec: 0,
        sourceKind: 'piano-roll',
        sourcePianoRoll: [{ id: 'n', note: 60, step: 0, length: 1, velocity: 90 }],
      },
    ],
    armed: ['roll-2'],
    globalProgram: 40,
  });
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 62, 77]);
  h.sec(1);
  h.send([0x80, 62, 0]);
  h.setStatus('stopping');
  assert.equal(
    h.clips[0].instrumentProgram,
    undefined,
    'the picker is NOT pinned onto the clip — it must keep following the picker',
  );
  assert.equal(h.clips[0].audioBlob, undefined, 'the picker plays it live, so it lands with no audio');
  await flush();
  assert.equal(h.rendered.length, 0, 'and nothing is rendered');
  assert.equal(h.renders.length, 0);
  h.dispose();
}

{
  // The track's own instrument beats the global picker, as effectiveProgramFor
  // resolves it: the take carries the track's program and plays live on it.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'], globalProgram: 40 });
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 60, 100]);
  h.sec(1);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips[0].instrumentProgram, 0, "the track's own program wins");
  await flush();
  assert.equal(h.rendered.length, 0, 'it plays live, so nothing is rendered');
  h.dispose();
}

{
  // An armed drum track with no clips and no program is a MIDI track: the pass
  // lands on it and plays on the drum channel with the Standard kit (never the
  // picker's instrument), live, so nothing is rendered. At 8039b45 the drum key
  // did not exist, and a track like this recorded the mic.
  resetMidiTakeSeq();
  const drums: CaptureTrack = { id: 'drums-1', color: '#fa0', isPercussion: true };
  assert.equal(capturesMidi(drums, []), true);
  const h = harness({ tracks: [drums], armed: ['drums-1'], globalProgram: 40 });
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 36, 100]);
  h.sec(0.6);
  h.send([0x80, 36, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 1);
  assert.equal(h.clips[0].instrumentProgram, undefined, 'the kit is the track default, not pinned');
  assert.equal(h.clips[0].audioBlob, undefined, 'the kit plays it live, so it lands with no audio');
  await flush();
  assert.equal(h.rendered.length, 0, 'and nothing is rendered');
  h.dispose();
}

{
  // Two armed MIDI tracks: one pass, two clips, still ONE undo step.
  resetMidiTakeSeq();
  const h = harness({
    tracks: [MIDI_TRACK, { id: 'midi-2', color: '#0ff', instrumentProgram: 32 }],
    armed: ['midi-1', 'midi-2'],
  });
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 60, 100]);
  h.sec(1);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 2, 'both armed MIDI tracks took the pass');
  assert.deepEqual(h.clips.map((c) => c.label), ['MIDI take 1', 'MIDI take 2']);
  assert.equal(h.undoSteps(), 1, 'one press is one undo step however many tracks');
  h.dispose();
}

{
  // Punch: the notes are cropped to the window and the clip starts at the in
  // point, exactly as placeTakes crops a take.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'], punch: { from: 4, to: 6 } });
  h.sec(2);
  h.setStatus('recording');
  h.sec(3); // before the in point
  h.send([0x90, 60, 100]);
  h.sec(5); // released inside
  h.send([0x80, 60, 0]);
  h.sec(5.5); // wholly inside
  h.send([0x90, 62, 90]);
  h.sec(5.75);
  h.send([0x80, 62, 0]);
  h.sec(8);
  h.setStatus('idle');
  assert.equal(h.clips.length, 1);
  near(h.clips[0].startSec, 4, 'the clip starts at the punch-in point, not at the press');
  assert.deepEqual(
    h.clips[0].sourceRollNotes?.map((n) => [n.note, n.step, n.length]),
    [
      [60, 0, 8], // 4 -> 5 s, one second = 8 steps
      [62, 12, 2], // 5.5 -> 5.75 s
    ],
    'the part before the in point is trimmed off the first note',
  );
  h.dispose();
}

{
  // Punch that keeps nothing: the notes were played, so the notice says so.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'], punch: { from: 20, to: 30 } });
  h.setStatus('recording');
  h.sec(1);
  h.send([0x90, 60, 100]);
  h.sec(2);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 0);
  assert.deepEqual(h.notices, [PUNCH_EMPTY_MIDI_MESSAGE], 'not "no MIDI received" — MIDI was received');
  h.dispose();
}

{
  // The status flip is what opens and closes. A repeat of the same status does
  // nothing, and 'counting' (the count-in) is not yet a pass.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  h.setStatus('counting');
  h.sec(1);
  h.send([0x90, 60, 100]);
  h.sec(2);
  h.send([0x80, 60, 0]);
  h.setStatus('counting');
  assert.equal(h.clips.length, 0, 'a count-in captures nothing');
  h.setStatus('recording');
  h.setStatus('recording');
  h.sec(3);
  h.send([0x90, 64, 100]);
  h.sec(4);
  h.send([0x80, 64, 0]);
  h.setStatus('stopping');
  h.setStatus('idle');
  assert.equal(h.clips.length, 1, 'exactly one clip — stopping then idle is one close');
  assert.equal(h.clips[0].sourceRollNotes?.length, 1, 'and only what was played while recording');
  h.dispose();
}

{
  // Nothing armed at all: no capture, no notice.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: [] });
  h.setStatus('recording');
  h.send([0x90, 60, 100]);
  h.setStatus('idle');
  assert.equal(h.clips.length, 0);
  assert.deepEqual(h.notices, []);
  h.dispose();
}

{
  // The disposer unsubscribes; a pass in flight is dropped, not landed.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  assert.equal(h.midiSubs, 1);
  h.setStatus('recording');
  h.sec(1);
  h.send([0x90, 60, 100]);
  h.dispose();
  assert.equal(h.midiSubs, 0, 'the bus subscription is gone');
  h.setStatus('idle');
  assert.equal(h.clips.length, 0, 'a disposed mount lands nothing');
}

{
  // A take that ends on a held chord: the pass closes at the chord's note-off,
  // the clip lands as long as its notes, and the render rings 1.5 s past them
  // (a string section's release). At 8039b45 applyClipRender wrote only
  // sourceDuration, so the clip still ended at the note-off and EDIT playback
  // and export cut the release there. (A track with no program: its takes are
  // rendered when they land.)
  resetMidiTakeSeq();
  const h = harness({ tracks: [PLAIN_MIDI_TRACK], existingClips: PLAIN_MIDI_CLIPS, armed: ['roll-0'], ringSec: 1.5 });
  h.sec(0);
  h.setStatus('recording');
  h.sec(0.5);
  for (const k of [60, 64, 67]) h.send([0x90, k, 100]);
  h.sec(2.5);
  for (const k of [60, 64, 67]) h.send([0x80, k, 0]);
  h.setStatus('stopping');
  const clip = h.clips[0];
  const nominal = clip.durationSec;
  near(nominal, 20 * 0.125, 'the clip lands ending at the note-off');
  await flush();
  assert.equal(h.renders.length, 1);
  near(h.renders[0].updates.sourceDuration ?? 0, nominal + 1.5, 'the source is the whole render');
  near(h.renders[0].updates.durationSec ?? 0, nominal + 1.5, 'and the clip grows to hold the ring-out');
  h.dispose();
}

{
  // The same take trimmed by the user while it rendered keeps the window the
  // user gave it; only the source length follows the render.
  resetMidiTakeSeq();
  const h = harness({ tracks: [PLAIN_MIDI_TRACK], existingClips: PLAIN_MIDI_CLIPS, armed: ['roll-0'], ringSec: 1.5 });
  h.sec(0);
  h.setStatus('recording');
  h.sec(0.5);
  h.send([0x90, 60, 100]);
  h.sec(2.5);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  h.clips[0].durationSec = 1;
  await flush();
  near(h.renders[0].updates.sourceDuration ?? 0, 20 * 0.125 + 1.5, 'the source is the whole render');
  assert.equal(h.renders[0].updates.durationSec, undefined, 'the trimmed window is left alone');
  h.dispose();
}

{
  // A hardware controller played with the notes: the mod wheel (CC 1) and the
  // expression pedal (CC 11) land on the take as its roll part's controller
  // changes, at the ticks they were played on (960 to the quarter at 120 BPM);
  // a controller a part does not keep (CC 93, chorus) is read past.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  h.sec(4);
  h.setStatus('recording');
  h.send([0xb0, 1, 20]); // at the pass's start
  h.sec(4.5);
  h.send([0x90, 60, 100]);
  h.send([0xb0, 11, 64]);
  h.send([0xb0, 93, 50]);
  h.sec(5);
  h.send([0xb0, 11, 110]);
  h.send([0xb3, 1, 90]); // another channel: the one input stream is the take's
  h.sec(6);
  h.send([0x80, 60, 0]);
  h.setStatus('stopping');
  assert.equal(h.clips.length, 1);
  const part = h.clips[0].sourceRollPart;
  assert.ok(part, 'the take carries a roll part for its controllers');
  assert.equal(part.program, 0, 'the part plays the instrument of its track');
  assert.deepEqual(
    part.controls?.map((c) => [c.tick, c.controller, c.value]),
    [
      [0, 1, 20],
      [960, 11, 64],
      [1920, 11, 110],
      [1920, 1, 90],
    ],
    'each change at its tick from the clip start, chorus left out',
  );
  h.dispose();

  // A pass with notes only lands no roll part, as every take did before.
  resetMidiTakeSeq();
  const plain = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  plain.setStatus('recording');
  plain.send([0x90, 62, 90]);
  plain.sec(1);
  plain.setStatus('stopping');
  assert.equal(plain.clips[0].sourceRollPart, undefined);
  plain.dispose();

  // The capture core keeps controllers apart from notes, and a punch window crops them.
  let t = 0;
  const cap = createNoteCapture({ now: () => t });
  cap.open();
  cap.onMessage([0xb0, 64, 127]);
  t = 2;
  cap.onMessage([0xb0, 64, 0]);
  t = 3;
  assert.deepEqual(cap.close(), [], 'no notes');
  const played = cap.takeControls();
  assert.deepEqual(played.map((c) => [c.controller, c.value, c.sec]), [[64, 127, 0], [64, 0, 2]]);
  assert.deepEqual(cap.takeControls(), [], 'taken once');
  assert.deepEqual(
    capturedControlsToRoll(played, { bpm: 60, originSec: 1, window: { from: 1, to: 5 } })?.map((c) => [c.tick, c.value]),
    [[960, 0]],
    'the pedal-down before the punch window is cropped; the pedal-up lands a beat in at 60 BPM',
  );
}

{
  // An MPE controller: two notes, each on a channel of its own, each shaped by its channel's
  // pressure, CC 74 and wheel. The take's notes carry them as their own expression; the
  // CC 74 is the notes', not the part's.
  resetMidiTakeSeq();
  const h = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  h.sec(0);
  h.setStatus('recording');
  // Channel 2 is set just before its note starts, as an MPE controller sends it.
  h.send([0xd1, 30]);
  h.send([0xb1, 74, 64]);
  h.send([0xe1, 0x00, 0x40]);
  h.send([0x91, 60, 100]);
  h.sec(0.5);
  h.send([0xd1, 110]); // pressure swells on channel 2 only
  h.send([0x92, 64, 90]); // channel 3's note, with nothing set: no start values
  h.sec(0.75);
  h.send([0xe2, 0x7f, 0x7f]); // channel 3 bends to the top
  h.sec(1);
  h.send([0x81, 60, 0]);
  h.send([0x82, 64, 0]);
  h.setStatus('stopping');
  const [c, e] = (h.clips[0].sourceRollNotes ?? []).slice().sort((a, b) => a.note - b.note);
  assert.ok(c.expr, 'the C carries the expression of its channel');
  assert.equal(c.expr.pressure, 30 / 127, 'its pressure where it started');
  assert.equal(c.expr.timbre, 64 / 127);
  assert.equal(c.expr.pitchBend, 0);
  assert.equal(c.expr.bendRange, 48, 'at 48 semitones, the MPE members range');
  assert.deepEqual(c.expr.curves?.pressure?.map((p) => [p.tick, p.value]), [[960, 110 / 127]], 'the swell half a second in, a beat at 120');
  assert.equal(e.expr?.pressure, undefined, 'the E started with nothing set');
  assert.deepEqual(e.expr?.curves?.pitchBend?.map((p) => [p.tick, p.value]), [[480, 1]], 'and bent to the top a quarter second in');
  assert.equal(h.clips[0].sourceRollPart, undefined, 'the CC 74 belonged to the notes: no part controller');
  h.dispose();

  // One keyboard on one channel: its aftertouch is not any one note's.
  resetMidiTakeSeq();
  const one = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  one.setStatus('recording');
  one.send([0x90, 60, 100]);
  one.send([0x90, 64, 100]);
  one.sec(0.5);
  one.send([0xd0, 90]);
  one.sec(1);
  one.setStatus('stopping');
  assert.ok((one.clips[0].sourceRollNotes ?? []).every((n) => n.expr === undefined), 'no expression on a one-channel pass');
  one.dispose();

  // A split keyboard: the bass hand on channel 2, the melody on channel 1 with the wheel on it. Not MPE:
  // the wheel bends the melody's channel at the synth's own range, so no note takes a 48-semitone bend.
  resetMidiTakeSeq();
  const split = harness({ tracks: [MIDI_TRACK], armed: ['midi-1'] });
  split.setStatus('recording');
  split.send([0x91, 36, 90]);
  split.send([0x90, 72, 100]);
  split.sec(0.5);
  split.send([0xe0, 0x00, 0x60]);
  split.sec(1);
  split.send([0x80, 72, 0]);
  split.send([0x81, 36, 0]);
  split.setStatus('stopping');
  assert.ok((split.clips[0].sourceRollNotes ?? []).every((n) => n.expr === undefined), 'no note of a split keyboard carries an MPE bend');
  split.dispose();
  // Punched in part way through a note: it starts at the pressure it had at the cut.
  const held: CapturedNote = { note: 60, velocity: 100, startSec: 0, endSec: 2, channel: 1, expr: { pressure: 10 / 127, changes: [{ sec: 0.5, dim: 'pressure', value: 120 / 127 }, { sec: 1.5, dim: 'pressure', value: 60 / 127 }] } };
  const [punched] = cropNotesToWindow([held], { from: 1, to: 2 });
  assert.equal(punched.expr?.pressure, 120 / 127, 'the swell before the cut is where it starts');
  assert.deepEqual(punched.expr?.changes, [{ sec: 0.5, dim: 'pressure', value: 60 / 127 }], 'and the change after it keeps its place');

  // Two hands on one channel each, a chord in the left: not one note at a time, not MPE.
  assert.equal(
    isMpePass([
      { note: 36, velocity: 90, startSec: 0, endSec: 1, channel: 1, expr: { pressure: 0.5, changes: [] } },
      { note: 40, velocity: 90, startSec: 0, endSec: 1, channel: 1 },
      { note: 72, velocity: 90, startSec: 0, endSec: 1, channel: 0 },
    ]),
    false,
  );

  assert.deepEqual(parseExpressionMessage([0xd3, 127]), { dim: 'pressure', channel: 3, value: 1 });
  assert.deepEqual(parseExpressionMessage([0xe0, 0, 0]), { dim: 'pitchBend', channel: 0, value: -1 });
  assert.equal(parseExpressionMessage([0xb0, 7, 90]), null, 'volume belongs to the part');
}

console.log('midiCapture: ok');
