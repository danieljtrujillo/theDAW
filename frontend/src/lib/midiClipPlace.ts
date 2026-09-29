/**
 * midiClipPlace — a MIDI file as ONE piano-roll clip on EDIT's timeline: a
 * LIBRARY MIDI row dragged onto a lane, the add-to-track menu's "MIDI file",
 * and a MIDI pick from the library picker (WaveformEditor addMidiClipFromBytes).
 *
 * The clip holds the file as the roll reads it (lib/rollClip
 * midiFileClipFields: each note at its own ticks, each bending channel in its
 * own lane, the file's meter, pickup, tempo map and markers) and it sounds the
 * file's own voice (midiFileVoice): the program of its part with the most
 * notes, in the bank the file chose it in, and the drum channel when every
 * part holding notes is percussion (MIDI channel 10, or a drum bank). A song's
 * stem transcribed by basic-pitch takes its stem's instrument (lib/stemRole)
 * from `stem` (the label when left out). With no program in the file the
 * clip plays its track's, else the picker's, as before.
 *
 * Percussion belongs to the TRACK (lib/clipProgram): a drum file plays its
 * kit only on a drum track, and a pitched file plays pitched only on a
 * melodic one. A drop on a track of the other kind turns the track to the
 * file's kind when the track is blank (no clips, no instrument of its own),
 * and otherwise lands on a new track of the file's kind, so the track the
 * user pointed at keeps its voice and its clips keep theirs. A drop below
 * every lane, or with no track named, makes a track of the file's kind that
 * holds the file's program.
 *
 * The clip carries a part record (AudioClip `sourceRollPart`) naming its
 * program, channel and, for a library song's MIDI (`fromAudio`), the mark
 * that its notes were timed against the song's audio, so opening it in the
 * roll gives back a percussion part on channel 10 and MATCH keeps a
 * transcription's seconds (lib/tempoConform).
 *
 * The track, the clip and the file's markers on the timeline are one undo
 * step. No Vite-only imports, so node tests replay it against the real store.
 */
import { useEditorStore, type EditorTrack } from '../state/editorStore';
import { clipVoice, isPercussionTrack, type ClipVoice, type GlobalVoice } from './clipProgram';
import type { MidiFileData } from './midi';
import { midiFileClipFields, rollPartRef } from './rollClip';
import { clipOwnTimelineMarkers } from './rollMarkers';
import { midiFileToRollParts, type RollMidiPart } from './rollMidi';
import { stepClock } from './rollTempo';
import { PERCUSSION_PART_CHANNEL, makeRollTrack } from './rollTracks';

/** The voice a file's notes sound as one clip. */
export interface MidiFileVoice {
  /** The GM program (a kit's on a drum file), or undefined when the file sets none. */
  program: number | undefined;
  /** The bank select the program was chosen in (0 on a drum file). */
  bank: number;
  /** Every part holding notes is percussion. */
  percussion: boolean;
  /** How many parts hold notes. */
  parts: number;
  /** Some parts are percussion and some are not: one clip plays them all on the pitched program. */
  mixed: boolean;
  /** The part the voice was taken from (the one with the most notes). */
  source: RollMidiPart | null;
}

const isPercussionPart = (p: RollMidiPart): boolean => p.track.channel === PERCUSSION_PART_CHANNEL;

/**
 * The voice `parts` (a file read by lib/rollMidi midiFileToRollParts) sound
 * as one clip: the part with the most notes names the program, among the
 * pitched parts when there are any, and the clip is percussion only when
 * every part holding notes is.
 */
export function midiFileVoice(parts: readonly RollMidiPart[]): MidiFileVoice {
  const sounding = parts.filter((p) => p.notes.length > 0);
  const pitched = sounding.filter((p) => !isPercussionPart(p));
  const percussion = sounding.length > 0 && pitched.length === 0;
  const pool = percussion ? sounding : pitched;
  const source = pool.reduce<RollMidiPart | null>((best, p) => (!best || p.notes.length > best.notes.length ? p : best), null);
  const program = source?.track.program ?? undefined;
  return {
    program: program === null ? undefined : program,
    bank: percussion ? 0 : source?.track.bank ?? 0,
    percussion,
    parts: sounding.length,
    mixed: pitched.length > 0 && pitched.length < sounding.length,
    source,
  };
}

export interface MidiClipPlaceOptions {
  /** The clip's label, and its new track's name. */
  label: string;
  /** Where the clip starts on the timeline. */
  startSec: number;
  /** The track pointed at; null or left out makes a new one. */
  targetTrackId?: string | null;
  /** The song stem the file transcribes (lib/stemRole); the label when left out. */
  stem?: string;
  /** The notes were timed against a song's audio (a LIBRARY MIDI row). */
  fromAudio?: boolean;
}

export interface MidiClipPlaced {
  trackId: string;
  clipId: string;
  trackName: string;
  noteCount: number;
  durationSec: number;
  /** The file's voice (midiFileVoice). */
  file: MidiFileVoice;
  /** What the clip sounds on its track. */
  voice: ClipVoice;
  /** True when the clip is on a track made for it. */
  newTrack: boolean;
  /** The track pointed at played the other kind and held clips or an instrument, so the clip went on a new track. */
  movedFrom: string | null;
  /** The blank track pointed at was turned to the file's kind (a drum track, or a melodic one). */
  turned: boolean;
}

/** A track with nothing of its own to lose: no clips, no program, no instrument plugin, not a MIDI-out-only track or a folder. */
const blankTrack = (t: EditorTrack, clipsOn: number): boolean =>
  clipsOn === 0 && t.instrumentProgram === undefined && !t.instrument && !t.externalOnly && !t.isFolder;

/** A new roll document id for the clip's part record. */
const docUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `roll-${crypto.randomUUID()}` : `roll-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * Put `data` on the timeline as one piano-roll clip at `opts.startSec` (see
 * the header), in one undo step. Returns null when the file has no notes.
 */
export function placeMidiFileClip(data: MidiFileData, opts: MidiClipPlaceOptions, deps: { global: () => GlobalVoice }): MidiClipPlaced | null {
  const fields = midiFileClipFields(data, 'imp');
  if (fields.sourcePianoRoll.length === 0) return null;
  const file = midiFileVoice(midiFileToRollParts(data, 'imp', { stem: opts.stem ?? opts.label }).parts);
  const bpm = fields.sourceBpm;
  // The clip's length under the file's own tempo changes.
  const durationSec = stepClock(bpm, fields.sourceTempoMap).at(fields.sourceTotalSteps);
  const global = deps.global();
  const globalProgram = global.useSoundfont ? global.activeProgram : undefined;
  const editor = useEditorStore.getState();
  const pointed = opts.targetTrackId ? editor.tracks.find((t) => t.id === opts.targetTrackId) : undefined;
  const fits = !!pointed && isPercussionTrack(pointed) === file.percussion;
  const turnable = !!pointed && !fits && blankTrack(pointed, editor.clips.filter((c) => c.trackId === pointed.id).length);
  const record = makeRollTrack(
    {
      name: file.source?.track.name ?? opts.label,
      program: file.program ?? null,
      bank: file.bank,
      channel: file.percussion ? PERCUSSION_PART_CHANNEL : null,
      ...(file.source?.track.instrumentId ? { instrumentId: file.source.track.instrumentId } : {}),
      ...(opts.fromAudio ? { fromAudio: true } : {}),
    },
    0,
  );
  const { trackId, clipId } = editor.undoGroup(() => {
    const store = useEditorStore.getState();
    let trackId: string;
    if (pointed && (fits || turnable)) {
      trackId = pointed.id;
      // A blank track takes the file's kind: a drum file makes it a drum track, a pitched file a melodic one.
      if (turnable) store.updateTrack(trackId, { isPercussion: file.percussion ? true : undefined });
    } else {
      // A new track of the file's kind, on the file's program (a kit on a drum track), else the picker's.
      trackId = store.addTrack({
        name: opts.label,
        ...(file.percussion ? { isPercussion: true } : {}),
        instrumentProgram: file.program ?? (file.percussion ? undefined : globalProgram),
      });
    }
    const track = useEditorStore.getState().tracks.find((t) => t.id === trackId);
    const color = track?.color ?? '#a855f7';
    // The file's own program on the clip, over its track's, in the bank it was chosen in. A file
    // with none plays its track's program, else the picker's (a drum track its kit).
    const program = file.program ?? (isPercussionTrack(track) ? track?.instrumentProgram : track?.instrumentProgram ?? globalProgram);
    const clipId = useEditorStore.getState().addClipToTrack({
      trackId,
      label: opts.label,
      mimeType: 'audio/wav',
      sourceDuration: durationSec,
      offsetIntoSource: 0,
      durationSec,
      startSec: Math.max(0, opts.startSec),
      color,
      sourceKind: 'piano-roll',
      ...fields,
      sourceRollPart: rollPartRef(record, 0, docUid()),
      instrumentProgram: program,
      ...(file.program !== undefined && !file.percussion && file.bank > 0 ? { instrumentBank: file.bank } : {}),
    });
    // The file's markers (FF 06) on EDIT's timeline, where the clip plays them.
    const placed = useEditorStore.getState().clips.find((c) => c.id === clipId);
    if (placed?.sourceMarkers?.length) useEditorStore.getState().setClipRollMarkers(clipId, clipOwnTimelineMarkers(placed, bpm));
    return { trackId, clipId };
  });
  // A file whose tempo or meter differs from the arrangement's is offered for adoption (the banner above the timeline).
  useEditorStore.getState().offerClipTimeMaps(clipId);
  const now = useEditorStore.getState();
  const track = now.tracks.find((t) => t.id === trackId);
  const clip = now.clips.find((c) => c.id === clipId);
  return {
    trackId,
    clipId,
    trackName: track?.name ?? opts.label,
    noteCount: fields.sourcePianoRoll.length,
    durationSec,
    file,
    voice: clip ? clipVoice(clip, track, global) : { program: undefined, percussion: false },
    newTrack: !(pointed && (fits || turnable)),
    movedFrom: pointed && !fits && !turnable ? pointed.name : null,
    turned: turnable,
  };
}

/** The LOG lines a placed MIDI clip writes: what landed where and how it sounds, and why it is not where it was dropped. */
export function midiClipPlacedReport(done: MidiClipPlaced, label: string, startSec: number): { info: string[]; warn: string[] } {
  const kind = done.file.percussion ? 'drum' : 'pitched';
  const info = [
    `Added MIDI "${label}" (${done.noteCount} notes) to ${done.newTrack ? `a new ${done.file.percussion ? 'drum ' : ''}track` : done.trackName} at ${startSec.toFixed(2)}s; `
      + (done.voice.program !== undefined ? 'it plays live and renders when exported' : 'rendering its audio (it has no instrument to play live)'),
  ];
  if (done.turned) info.push(`"${done.trackName}" is a ${done.file.percussion ? 'drum' : 'melodic'} track now, for the ${kind} notes of "${label}"`);
  const warn: string[] = [];
  if (done.movedFrom) {
    warn.push(`"${label}" is a ${kind} part and "${done.movedFrom}" plays ${done.file.percussion ? 'pitched notes' : 'drums'}, so it went on a new track`);
  }
  if (done.file.mixed) {
    warn.push(`"${label}" holds drum and pitched parts; one clip plays them all on the pitched part's program. Import as tracks gives each part a track of its own`);
  }
  return { info, warn };
}
