/**
 * midiImportTracks — a MIDI file into EDIT as tracks, one per part ("Import as
 * tracks": the MIDI tab's IMPORT flyout and EDIT's add-to-track menu).
 *
 * The file is read into parts exactly as the roll's own import reads it
 * (lib/rollMidi midiFileToRollParts): one part per track, or per channel of a
 * track that holds several (a format 0 file), each on its program, bank and
 * channel, with its controller changes; a part on MIDI channel 10, or on a
 * drum bank, is percussion. Every part with notes lands on an EDIT track of its
 * own, named and coloured after the part and holding its voice (its program, or
 * the roll voice a part without one plays: the picker's), a percussion part on
 * a drum track, with one piano-roll clip starting at `atSec`. The clip holds
 * the part's program and the bank the file chose it in (lib/rollTracks
 * partClipSound, as the roll's EDIT key writes them), so EDIT's live notes and
 * every render play the file's bank, as the roll and the MIDI export do.
 *
 * Each clip holds its part's notes at their own ticks, rescaled to the roll's
 * 960 PPQ and never snapped, the file's tempo map, meter map, pickup, lanes and
 * bends, and a part record (AudioClip `sourceRollPart`, lib/rollClip
 * rollPartRef) naming one roll document for the whole file, so opening any of
 * the clips in the roll opens every part again, the clicked one active. Every
 * clip is as long as the longest part, to the bar line after its last note, so
 * they line up bar for bar.
 *
 * An arrangement with no clips takes the file's whole tempo map and meter map
 * from `atSec` on (editorStore adoptClipTimeMaps), so its grid lines up with
 * the parts bar for bar and its MIDI export writes every tempo and meter
 * change. An arrangement with clips keeps its own, and EDIT offers the file's
 * maps above the timeline (offerClipTimeMaps), as a clip sent from the roll
 * does; nothing changes until the offer is accepted.
 *
 * The file's markers (FF 06) ride on every clip (`sourceMarkers`), so any of
 * them reopens them in the roll, and go on EDIT's timeline once, written by the
 * first part's clip, as a send from the roll puts them.
 *
 * Every track and clip, the markers and the maps an empty arrangement takes,
 * are one undo step. A clip's audio is an optional render (lib/midiRender): a part with a
 * voice plays live on EDIT's synths and renders when an export needs it, so a
 * thirty-part file holds no audio. A part with no voice (no program and the
 * picker off) cannot play live: its render is queued on EDIT's MIDI render
 * queue (state/midiRenderQueue), which renders one clip at a time, marks the
 * render as made so the part can be heard, and drops it once the part plays
 * live. A clip deleted or undone before its turn is skipped by the queue.
 */
import { useEditorStore } from '../state/editorStore';
import { requestMidiRender } from '../state/midiRenderQueue';
import { clipVoice, type GlobalVoice } from './clipProgram';
import { roundUpToBar, type MeterSegment } from './meterMap';
import type { MidiFileData } from './midi';
import { rollClipFields, rollPartRef } from './rollClip';
import { clipOwnTimelineMarkers } from './rollMarkers';
import { midiFileToRollParts, type RollMidiPartsImport } from './rollMidi';
import { stepClock } from './rollTempo';
import { isPercussionPart, makeRollTrack, partClipSound, partVoice } from './rollTracks';
import type { TempoEvent } from './tempoMap';
import type { RollTrack } from '../state/pianoRollStore';

export interface MidiTracksDeps {
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
  /** Told as each queued part's audio lands, with how many are done of how many queued. */
  onRendered?: (done: number, of: number, partName: string) => void;
  /** Told when a queued part's render fails; the clip keeps its notes, and EDIT's render upkeep tries again. */
  onRenderError?: (partName: string, error: unknown) => void;
}

/** One part as it lands: its EDIT track and clip, and what it holds. */
export interface MidiTrackPart {
  partId: string;
  name: string;
  trackId: string;
  clipId: string;
  noteCount: number;
  program: number | undefined;
  percussion: boolean;
  controlCount: number;
  /** True when the part has no voice to play live, so its render was queued. */
  rendering: boolean;
}

export interface MidiTracksResult {
  /** The roll document every clip's part record names. */
  doc: string;
  parts: MidiTrackPart[];
  noteCount: number;
  /** The clips' length in steps, and in seconds under the file's tempo map. */
  totalSteps: number;
  durationSec: number;
  /** The tempo map and the meter map every clip holds (the file's, as the roll reads them). */
  tempoMap: TempoEvent[];
  meterMap: MeterSegment[];
  /**
   * The arrangement's tempo and meter maps once it took the file's (an
   * arrangement with no clips); null when it kept its own, and the file's
   * were offered instead.
   */
  arrangement: { tempoMap: TempoEvent[]; meterMap: MeterSegment[] } | null;
  /** True when the arrangement kept its own maps and EDIT offers the file's above the timeline. */
  offered: boolean;
  /** Resolves with how many queued renders landed once each has landed or failed; 0 when every part plays live. */
  rendered: Promise<number>;
}

/** A new roll document id for the file's clips. */
const docUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `roll-${crypto.randomUUID()}` : `roll-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * The parts of `data` that have notes, each a whole roll part (ids made,
 * fields cleaned), with the document every clip shares: tempo, tempo map,
 * meter, lanes and bends, and the length in steps that holds the longest part.
 */
export function midiFileTrackParts(
  data: MidiFileData,
  idPrefix = 'imp',
  stem?: string,
): Omit<RollMidiPartsImport, 'parts'> & { parts: RollTrack[]; totalSteps: number } {
  const file = midiFileToRollParts(data, idPrefix, { stem });
  const parts = file.parts.filter((p) => p.notes.length > 0).map((p, i) => makeRollTrack({ ...p.track, notes: p.notes }, i));
  const noteEnd = parts.reduce((m, t) => t.notes.reduce((e, n) => Math.max(e, n.step + n.length), m), 0);
  const totalSteps = roundUpToBar(file.meter.meterMap, Math.max(1, noteEnd), file.meter.pickupSteps);
  return { bpm: file.bpm, meter: file.meter, bends: file.bends, tempoMap: file.tempoMap, markers: file.markers, parts, totalSteps };
}

/**
 * Put every part of `data` on an EDIT track of its own, each with one clip at
 * `atSec`, in one undo step, and queue a render for each part that cannot
 * play live. Returns null when the file has no notes.
 */
export function importMidiAsTracks(
  data: MidiFileData,
  opts: { label: string; atSec: number; idPrefix?: string; stem?: string },
  deps: MidiTracksDeps,
): MidiTracksResult | null {
  // The label names the file ("bass", "Song · bass"): a stem's transcription plays its stem's instrument (lib/stemRole).
  const file = midiFileTrackParts(data, opts.idPrefix ?? 'imp', opts.stem ?? opts.label);
  if (!file.parts.length) return null;
  const bpm = Number.isFinite(file.bpm) && file.bpm > 0 ? file.bpm : 120;
  const doc = docUid();
  const atSec = Math.max(0, Number.isFinite(opts.atSec) ? opts.atSec : 0);
  const shared = rollClipFields({
    ...file.meter,
    notes: [],
    bpm,
    totalSteps: file.totalSteps,
    bends: file.bends,
    tempoMap: file.tempoMap,
  });
  const durationSec = stepClock(bpm, shared.sourceTempoMap).at(file.totalSteps);
  const global = deps.global();
  const editor = useEditorStore.getState();
  const landed: MidiTrackPart[] = [];
  // An arrangement with no clips takes the file's maps; one with clips keeps its own and is offered them.
  const takesTiming = editor.clips.length === 0;
  editor.undoGroup(() => {
    file.parts.forEach((part, order) => {
      // The part's own program, else a kit on the drum track, else the picker's: what a new track holds (lib/rollTracks partVoice).
      const voice = partVoice(part, null, [], [], global, null);
      // What its clip holds over the track: the part's program with the file's bank, as a send from the roll writes it.
      const sound = partClipSound(part, voice);
      const percussion = isPercussionPart(part);
      const fields = {
        ...rollClipFields({ ...file.meter, notes: part.notes, bpm, totalSteps: file.totalSteps, bends: file.bends, tempoMap: file.tempoMap, markers: file.markers }),
        sourceRollPart: rollPartRef(part, order, doc),
      };
      const trackId = useEditorStore.getState().addTrack({
        name: part.name,
        instrumentProgram: voice.program,
        ...(percussion ? { isPercussion: true } : {}),
        color: part.color,
        // A part's name is the track's, never replaced by a clip label as an automatic name is.
        nameAutoGenerated: false,
        ...(part.mute ? { mute: true } : {}),
      });
      // No audio of its own: its window is the whole grid under the file's tempo map.
      const clipId = useEditorStore.getState().addClipToTrack({
        trackId,
        label: opts.label,
        mimeType: 'audio/wav',
        sourceDuration: durationSec,
        offsetIntoSource: 0,
        durationSec,
        startSec: atSec,
        color: part.color,
        sourceKind: 'piano-roll',
        ...fields,
        // A part with a program of its own keeps it on its clip, over its track's, in the
        // bank the file chose it in, so EDIT's live notes and every render (the audio
        // export and a freeze included) sound what the roll and the MIDI export sound.
        ...(sound.program !== undefined ? { instrumentProgram: sound.program } : {}),
        ...(sound.bank > 0 ? { instrumentBank: sound.bank } : {}),
      });
      const now = useEditorStore.getState();
      const clip = now.clips.find((c) => c.id === clipId);
      const heard = clip ? clipVoice(clip, now.tracks.find((t) => t.id === trackId), global) : voice;
      landed.push({
        partId: part.id,
        name: part.name,
        trackId,
        clipId,
        noteCount: fields.sourcePianoRoll.length,
        program: heard.program,
        percussion,
        controlCount: part.controls?.length ?? 0,
        rendering: heard.program === undefined,
      });
    });
    // The file's markers on EDIT's timeline, once: the first part's clip writes them.
    const first = landed.length ? useEditorStore.getState().clips.find((c) => c.id === landed[0].clipId) : undefined;
    if (first?.sourceMarkers?.length) useEditorStore.getState().setClipRollMarkers(first.id, clipOwnTimelineMarkers(first, bpm));
    // The file's tempo and meter from the first clip's start, for an arrangement that has nothing to keep.
    if (takesTiming && landed.length) useEditorStore.getState().adoptClipTimeMaps(landed[0].clipId);
  });
  const after = useEditorStore.getState();
  // An arrangement that kept its own maps is offered the file's (the banner above the timeline).
  if (!takesTiming && landed.length) after.offerClipTimeMaps(landed[0].clipId);
  const offered = !takesTiming && useEditorStore.getState().timeMapOffer?.clipId === landed[0]?.clipId;
  const rendered = queueRenders(landed.filter((p) => p.rendering), deps);
  return {
    doc,
    parts: landed,
    noteCount: landed.reduce((n, p) => n + p.noteCount, 0),
    totalSteps: file.totalSteps,
    durationSec,
    tempoMap: file.tempoMap.map((e) => ({ ...e, ...(e.fermata ? { fermata: { ...e.fermata } } : {}) })),
    meterMap: file.meter.meterMap.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...s.meter.groups] } })),
    arrangement: takesTiming
      ? {
          tempoMap: after.tempoMap.map((e) => ({ ...e })),
          meterMap: after.meterMap.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...s.meter.groups] } })),
        }
      : null,
    offered,
    rendered,
  };
}

/**
 * Queue each part that cannot play live on EDIT's MIDI render queue ('cache':
 * made so it can be heard, dropped once it plays live). The queue renders one
 * clip at a time and skips a clip that is gone when its turn comes. Resolves
 * with the renders written.
 */
async function queueRenders(parts: readonly MidiTrackPart[], deps: MidiTracksDeps): Promise<number> {
  let written = 0;
  await Promise.all(parts.map(async (p) => {
    try {
      const outcome = await requestMidiRender(p.clipId, 'cache');
      if (outcome.kind === 'written') {
        written += 1;
        deps.onRendered?.(written, parts.length, p.name);
      }
    } catch (e) {
      deps.onRenderError?.(p.name, e);
    }
  }));
  return written;
}

/** The tempo in a LOG line, to the hundredth. */
const bpmText = (bpm: number): string => String(Math.round(bpm * 100) / 100);

/**
 * The LOG lines an import writes (lib/midiImportTracksApp logs them): what
 * landed, at the tempo the clips play from (their own tempo map's start, 120
 * when the file's first tempo comes later than a 64th note in, lib/midi
 * midiStartTempo) with its changes and time signatures, and how the parts
 * sound (live, or rendered so they can be heard); what EDIT took from the
 * file; and, as a warning, that an arrangement which kept its own maps writes
 * them in its MIDI export until the file's offered maps are accepted.
 */
export function importTracksReport(done: MidiTracksResult, label: string, atSec: number): { info: string[]; warn: string[] } {
  const tempos = done.tempoMap.filter((e) => !e.fermata);
  const startBpm = tempos[0]?.bpm ?? 120;
  const tempoChanges = Math.max(0, tempos.length - 1);
  const meters = done.meterMap.length;
  const drums = done.parts.filter((p) => p.percussion).length;
  const controllers = done.parts.reduce((n, p) => n + p.controlCount, 0);
  const queued = done.parts.filter((p) => p.rendering).length;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const how = queued === 0
    ? 'every part plays live'
    : queued === done.parts.length
      ? 'rendering them one at a time so they can be heard (no instrument to play live)'
      : `${plural(queued, 'part')} with no instrument rendering so ${queued === 1 ? 'it' : 'they'} can be heard, the rest play live`;
  const info = [
    `Import as tracks: ${plural(done.parts.length, 'part')} of "${label}" on new tracks at ${atSec.toFixed(2)}s ` +
      `(${done.noteCount} notes${drums ? `, ${drums} on drum tracks` : ''}${controllers ? `, ${controllers} controller changes` : ''}, ` +
      `${bpmText(startBpm)} BPM${tempoChanges ? ` with ${plural(tempoChanges, 'tempo change')}` : ''}` +
      `${meters > 1 ? `, ${meters} time signatures` : ''}); ${how}`,
  ];
  const warn: string[] = [];
  if (done.arrangement) {
    const first = done.arrangement.meterMap[0]?.meter;
    const tempoWord = tempoChanges ? `${bpmText(startBpm)} BPM and its ${plural(tempoChanges, 'tempo change')}` : `${bpmText(startBpm)} BPM`;
    const meterWord = meters > 1 ? `its ${meters} time signatures` : first ? `${first.num}/${first.den}` : '';
    info.push(`Import as tracks: EDIT takes the file's ${tempoWord}${meterWord ? ` and ${meterWord}` : ''}`);
  } else if (done.offered) {
    info.push(`Import as tracks: EDIT keeps its own tempo and time signatures; the file's are offered above the timeline`);
    warn.push(
      `Import as tracks: the clips play "${label}" with its own tempo and time signatures, and the arrangement's MIDI export writes EDIT's until the offer above the timeline is accepted`,
    );
  }
  return { info, warn };
}
