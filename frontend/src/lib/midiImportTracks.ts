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
 * a drum track, with one piano-roll clip starting at `atSec`.
 *
 * Each clip holds its part's notes at their own ticks, rescaled to the roll's
 * 960 PPQ and never snapped, the file's tempo map, meter map, pickup, lanes and
 * bends, and a part record (AudioClip `sourceRollPart`, lib/rollClip
 * rollPartRef) naming one roll document for the whole file, so opening any of
 * the clips in the roll opens every part again, the clicked one active. Every
 * clip is as long as the longest part, to the bar line after its last note, so
 * they line up bar for bar.
 *
 * An arrangement with no clips takes the file's start tempo and first time
 * signature (EDIT holds one of each), so its grid lines up with the parts and
 * its MIDI export writes the file's tempo and meter. An arrangement with clips
 * keeps its own. The file's later tempo and meter changes stay on the clips,
 * which play and reopen with them.
 *
 * Every track and clip is made in one undo step. A clip first carries a short
 * silent placeholder and its nominal length; its audio renders in the
 * background, one part at a time so thirty parts do not start thirty renders at
 * once, and each render adds no undo step of its own (applyClipRender). Each
 * clip is claimed for this import's renders (lib/clipRerender
 * claimClipRender) before it reaches the store and released before its render
 * is written, so EDIT's instrument-sync pass, which sees the placeholder as a
 * stale render, leaves the clip to it: one render per part with EDIT open or
 * closed. A clip deleted or undone before its turn is released unrendered, and
 * EDIT renders it if it comes back.
 *
 * The render and the peak scan are passed in, so node tests replay an import
 * against the real editor store.
 */
import { useEditorStore, type AudioClip } from '../state/editorStore';
import type { RollControl, RollTrack } from '../state/pianoRollStore';
import { clipVoice, renderedVoiceFields, type GlobalVoice } from './clipProgram';
import { claimClipRender, releaseClipRender } from './clipRerender';
import { renderedWindowFields } from './clipRenderWindow';
import { roundUpToBar, type MeterSegment } from './meterMap';
import type { MidiFileData } from './midi';
import { silentWavBlob } from './midiCapture';
import type { RollRenderBends } from './pitchBend';
import { clipRenderInput, rollClipFields, rollPartRef } from './rollClip';
import { midiFileToRollParts, type RollMidiPartsImport } from './rollMidi';
import { stepClock } from './rollTempo';
import { isPercussionPart, makeRollTrack, partVoice } from './rollTracks';
import type { TempoEvent } from './tempoMap';

export interface MidiTracksDeps {
  /** lib/midiSynth renderStepNotesToBlob. */
  render: (
    notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
    bpm: number,
    totalSteps: number,
    opts: {
      program?: number;
      percussion?: boolean;
      bends?: RollRenderBends;
      tempoMap?: readonly TempoEvent[];
      controls?: readonly RollControl[];
    },
  ) => Promise<{ blob: Blob; duration: number }>;
  /** editorStore computePeaks. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array }>;
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
  /** soundfontEngine ensureSoundfontReady, awaited before the first render. */
  ensureReady?: () => Promise<unknown>;
  /** Told as each part's audio lands, with how many are done of how many. */
  onRendered?: (done: number, of: number, partName: string) => void;
  /** Told when a part's render fails; the clip keeps its notes and plays live. */
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
   * The tempo and time signature EDIT took from the file (its start tempo and
   * first time signature) when the arrangement had no clips; null when the
   * arrangement kept its own.
   */
  arrangement: { bpm: number; timeSignature: { num: number; den: number } } | null;
  /** Resolves with how many renders landed once every part has rendered (or failed). */
  rendered: Promise<number>;
}

/** A new roll document id for the file's clips. */
const docUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `roll-${crypto.randomUUID()}` : `roll-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** A new clip id, made here so the clip is claimed before the store holds it. */
const clipUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * The parts of `data` that have notes, each a whole roll part (ids made,
 * fields cleaned), with the document every clip shares: tempo, tempo map,
 * meter, lanes and bends, and the length in steps that holds the longest part.
 */
export function midiFileTrackParts(
  data: MidiFileData,
  idPrefix = 'imp',
): Omit<RollMidiPartsImport, 'parts'> & { parts: RollTrack[]; totalSteps: number } {
  const file = midiFileToRollParts(data, idPrefix);
  const parts = file.parts.filter((p) => p.notes.length > 0).map((p, i) => makeRollTrack({ ...p.track, notes: p.notes }, i));
  const noteEnd = parts.reduce((m, t) => t.notes.reduce((e, n) => Math.max(e, n.step + n.length), m), 0);
  const totalSteps = roundUpToBar(file.meter.meterMap, Math.max(1, noteEnd), file.meter.pickupSteps);
  return { bpm: file.bpm, meter: file.meter, bends: file.bends, tempoMap: file.tempoMap, parts, totalSteps };
}

/**
 * Put every part of `data` on an EDIT track of its own, each with one clip at
 * `atSec`, in one undo step, and render their audio one after another. Returns
 * null when the file has no notes.
 */
export function importMidiAsTracks(
  data: MidiFileData,
  opts: { label: string; atSec: number; idPrefix?: string },
  deps: MidiTracksDeps,
): MidiTracksResult | null {
  const file = midiFileTrackParts(data, opts.idPrefix ?? 'imp');
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
  // An arrangement with no clips takes the file's start tempo and first time signature; one with clips keeps its own.
  const takesTiming = editor.clips.length === 0;
  const startBpm = file.tempoMap[0]?.bpm ?? bpm;
  const firstMeter = file.meter.meterMap[0]?.meter;
  // Every clip claimed for renderInTurn, so an import that fails part way can hand them back.
  const claimed: string[] = [];
  try {
    editor.undoGroup(() => {
      if (takesTiming) {
        const now = useEditorStore.getState();
        if (Math.abs(now.bpm - startBpm) > 1e-9) now.setBpm(startBpm);
        // A meter EDIT cannot bar out is refused there, and the arrangement keeps its own.
        if (firstMeter) now.setTimeSignature(firstMeter.num, firstMeter.den);
      }
      file.parts.forEach((part, order) => {
        // The part's own program, else a kit on the drum track, else the picker's: what a new track holds (lib/rollTracks partVoice).
        const voice = partVoice(part, null, [], [], global, null);
        const percussion = isPercussionPart(part);
        const fields = {
          ...rollClipFields({ ...file.meter, notes: part.notes, bpm, totalSteps: file.totalSteps, bends: file.bends, tempoMap: file.tempoMap }),
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
        const clip: AudioClip = {
          id: clipUid(),
          trackId,
          label: opts.label,
          audioBlob: silentWavBlob(),
          mimeType: 'audio/wav',
          sourceDuration: durationSec,
          offsetIntoSource: 0,
          durationSec,
          startSec: atSec,
          color: part.color,
          sourceKind: 'piano-roll',
          ...fields,
          // A part with a program of its own keeps it on its clip, over its track's, as a bounce does.
          ...(part.program !== null ? { instrumentProgram: part.program } : {}),
        };
        // Claimed first: the store's change runs EDIT's instrument-sync pass, which must leave this clip to renderInTurn.
        claimClipRender(clip.id);
        claimed.push(clip.id);
        const clipId = useEditorStore.getState().addClipToTrack(clip);
        landed.push({
          partId: part.id,
          name: part.name,
          trackId,
          clipId,
          noteCount: fields.sourcePianoRoll.length,
          program: voice.program,
          percussion,
          controlCount: part.controls?.length ?? 0,
        });
      });
    });
  } catch (e) {
    // renderInTurn never runs: EDIT's instrument-sync pass renders whatever clips were made.
    for (const id of claimed) releaseClipRender(id, true);
    throw e;
  }
  const rendered = renderInTurn(landed, bpm, file.totalSteps, deps);
  const after = useEditorStore.getState();
  return {
    doc,
    parts: landed,
    noteCount: landed.reduce((n, p) => n + p.noteCount, 0),
    totalSteps: file.totalSteps,
    durationSec,
    tempoMap: file.tempoMap.map((e) => ({ ...e })),
    meterMap: file.meter.meterMap.map((s) => ({ bar: s.bar, meter: { ...s.meter, groups: [...s.meter.groups] } })),
    arrangement: takesTiming ? { bpm: after.bpm, timeSignature: { num: after.timeSignature.num, den: after.timeSignature.den } } : null,
    rendered,
  };
}

/** The tempo in a LOG line, to the hundredth. */
const bpmText = (bpm: number): string => String(Math.round(bpm * 100) / 100);

/**
 * The LOG lines an import writes (lib/midiImportTracksApp logs them): what
 * landed, at the tempo the clips play from (their own tempo map's start, 120
 * when the file's first tempo comes later than a 64th note in, lib/midi
 * midiStartTempo) with its changes and time signatures; what EDIT took from
 * the file; and, as a warning, the tempo and meter changes the clips hold that
 * EDIT's one tempo and one time signature cannot, so the arrangement's MIDI
 * export leaves them out.
 */
export function importTracksReport(done: MidiTracksResult, label: string, atSec: number): { info: string[]; warn: string[] } {
  const tempos = done.tempoMap.filter((e) => !e.fermata);
  const startBpm = tempos[0]?.bpm ?? 120;
  const tempoChanges = Math.max(0, tempos.length - 1);
  const meters = done.meterMap.length;
  const drums = done.parts.filter((p) => p.percussion).length;
  const controllers = done.parts.reduce((n, p) => n + p.controlCount, 0);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const info = [
    `Import as tracks: ${plural(done.parts.length, 'part')} of "${label}" on new tracks at ${atSec.toFixed(2)}s ` +
      `(${done.noteCount} notes${drums ? `, ${drums} on drum tracks` : ''}${controllers ? `, ${controllers} controller changes` : ''}, ` +
      `${bpmText(startBpm)} BPM${tempoChanges ? ` with ${plural(tempoChanges, 'tempo change')}` : ''}` +
      `${meters > 1 ? `, ${meters} time signatures` : ''}); rendering audio in the background`,
  ];
  if (done.arrangement) {
    const ts = done.arrangement.timeSignature;
    const first = done.meterMap[0]?.meter;
    info.push(
      !first || (first.num === ts.num && first.den === ts.den)
        ? `Import as tracks: EDIT takes the file's ${bpmText(done.arrangement.bpm)} BPM and ${ts.num}/${ts.den}`
        : `Import as tracks: EDIT takes the file's ${bpmText(done.arrangement.bpm)} BPM and keeps ${ts.num}/${ts.den}: it cannot bar out the file's ${first.num}/${first.den}`,
    );
  }
  const warn: string[] = [];
  if (tempoChanges || meters > 1) {
    const held = [tempoChanges ? plural(tempoChanges, 'tempo change') : '', meters > 1 ? `${meters} time signatures` : ''].filter(Boolean).join(' and ');
    warn.push(
      `Import as tracks: the clips play "${label}" with its ${held}, but EDIT holds one tempo and one time signature, ` +
        "so the arrangement's MIDI export writes EDIT's alone",
    );
  }
  return { info, warn };
}

/**
 * Render each landed part's clip, one after another, through the voice it has
 * when its turn comes (a track changed meanwhile renders its new sound). A
 * clip deleted before its turn is skipped. Each clip's claim is released
 * before its render is written, and whatever happens to the clip, so a clip
 * whose voice changed while it rendered is left stale for EDIT's
 * instrument-sync pass to render again. Resolves with the renders written.
 */
async function renderInTurn(parts: readonly MidiTrackPart[], bpm: number, totalSteps: number, deps: MidiTracksDeps): Promise<number> {
  let written = 0;
  try {
    await deps.ensureReady?.();
  } catch {
    /* the render falls back to the built-in voice */
  }
  for (const [i, p] of parts.entries()) {
    const before = useEditorStore.getState();
    const clip = before.clips.find((c) => c.id === p.clipId);
    if (!clip) {
      releaseClipRender(p.clipId);
      continue;
    }
    const voice = clipVoice(clip, before.tracks.find((t) => t.id === clip.trackId), deps.global());
    try {
      // A clip whose lanes bend renders each note in its lane; the part's controllers ride along.
      const input = clipRenderInput(clip, totalSteps);
      const out = await deps.render(input.notes, clip.sourceBpm ?? bpm, totalSteps, {
        program: voice.program,
        percussion: voice.percussion,
        ...(input.bends ? { bends: input.bends } : {}),
        ...(clip.sourceTempoMap?.length ? { tempoMap: clip.sourceTempoMap } : {}),
        ...(input.controls ? { controls: input.controls } : {}),
      });
      const { peaks } = await deps.computePeaks(out.blob, 240);
      // Re-read: the clip may have been trimmed or deleted while it rendered.
      const live = useEditorStore.getState().clips.find((c) => c.id === p.clipId);
      if (!live) continue;
      // Released before the write: the write changes the clip's voice signature, and the pass it runs must see the clip.
      releaseClipRender(p.clipId);
      useEditorStore.getState().applyClipRender(
        p.clipId,
        { audioBlob: out.blob, mimeType: 'audio/wav', ...renderedWindowFields(live, out.duration), ...renderedVoiceFields(voice) },
        peaks,
      );
      written += 1;
      deps.onRendered?.(i + 1, parts.length, p.name);
    } catch (e) {
      deps.onRenderError?.(p.name, e);
    } finally {
      // A render that failed hands the clip to EDIT's instrument-sync pass, which tries it once more.
      releaseClipRender(p.clipId, true);
    }
  }
  return written;
}
