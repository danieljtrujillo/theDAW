/**
 * rollBounce — the piano roll's EDIT key: render the roll's parts and put them
 * on the EDIT timeline, one clip per part.
 *
 * Every part with notes renders through its own voice (lib/rollTracks
 * partVoice: its own program, else its linked clip's, else the roll's own or
 * the picker's), in its own Bank, as the roll plays it live (lib/rollPartVoice).
 * A part linked to an EDIT clip re-renders that clip in place, and a part with
 * a program of its own writes it onto the clip, with the bank it is chosen in
 * (`instrumentBank`), so EDIT plays what the roll played. A part with no clip,
 * or whose clip is gone, lands on a new EDIT track named and coloured after
 * the part, holding the part's program (a percussion part makes a drum track),
 * so changing the picker later does not re-voice it; the part is then linked
 * to its new clip. A linked part that became a drum part (or stopped being
 * one) since its clip was made moves its clip onto a track of its kind: its
 * own track turns into one when the clip is alone there, otherwise the clip
 * goes to a new track beside it, so EDIT never plays drums through a melodic
 * program. Either way each clip records the voice its audio was rendered with
 * (`renderedProgram`, `renderedPercussion`, `renderedBank`), so EDIT's
 * instrument sync sees the audio is current, and the part it holds
 * (`sourceRollPart`), so opening any one of the clips opens every part again
 * (lib/rollClip clipPartsLoad).
 *
 * The tempo map, the meter map, the lanes and the bends are the document's,
 * so every part's clip carries the same ones.
 *
 * The render and the peak scan are passed in (PianoRoll gives lib/midiSynth and
 * editorStore's), so node tests replay a bounce against the real stores.
 */
import { useEditorStore, type AudioClip } from '../state/editorStore';
import { partLinkOf, rollTracksOf, usePianoRollStore, type RollTrack } from '../state/pianoRollStore';
import { isPercussionTrack, renderedVoiceFields, type ClipVoice, type GlobalVoice } from './clipProgram';
import { unrollLanes } from './meterMap';
import { rollRenderBends, type RollRenderBends } from './pitchBend';
import { rollClipFields, rollPartRef } from './rollClip';
import { cleanPartBank, isDefaultPartName, isPercussionPart, partVoice } from './rollTracks';
import type { TempoEvent } from './tempoMap';

export interface RollBounceDeps {
  /** lib/midiSynth renderStepNotesToBlob. */
  render: (
    notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
    bpm: number,
    totalSteps: number,
    opts: { program?: number; bank?: number; percussion?: boolean; bends?: RollRenderBends; tempoMap?: readonly TempoEvent[] },
  ) => Promise<{ blob: Blob; duration: number }>;
  /** editorStore computePeaks. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array }>;
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
  /** Told as each part finishes, with how many are done of how many. */
  onPart?: (done: number, of: number, part: RollTrack) => void;
}

/** One part's bounce: its clip, and whether that clip was updated in place or made. */
export interface RollPartBounce {
  partId: string;
  kind: 'updated' | 'created';
  clipId: string;
  duration: number;
  noteCount: number;
}

export interface RollBounceResult {
  /** `updated` when every part re-rendered its linked clip; `created` when any part made a new clip. */
  kind: 'updated' | 'created';
  /** The active part's clip (the first bounced part's when the active part has no notes). */
  clipId: string;
  /** The longest part's seconds. */
  duration: number;
  /** Every part's notes as they sound. */
  noteCount: number;
  parts: RollPartBounce[];
}

/**
 * The track a linked part's clip belongs on: its own, when the track's kind
 * (drum or melodic) is the part's. A part with a sound of its own (a program,
 * or channel 10) switched to a kit or back since the clip was made needs the
 * other kind: the clip's track turns into it when the clip is alone there
 * (keeping its mixer and effects), holding the voice the part renders with;
 * with other clips on it, a new track of the part's kind, named and coloured
 * after the part, takes the clip, right below the old one, so the other clips
 * keep their voice. A part that follows the roll voice plays its clip's voice,
 * drums on a drum track included (lib/rollTracks partVoice), so its clip stays.
 */
function trackOfItsKind(clip: AudioClip, part: RollTrack, voice: ClipVoice): string {
  const editor = useEditorStore.getState();
  const track = editor.tracks.find((t) => t.id === clip.trackId);
  const drums = isPercussionPart(part);
  if (!drums && part.program === null) return clip.trackId;
  if (!track || isPercussionTrack(track) === drums) return clip.trackId;
  const alone = !editor.clips.some((c) => c.trackId === track.id && c.id !== clip.id);
  if (alone) {
    editor.updateTrack(track.id, { isPercussion: drums ? true : undefined, instrumentProgram: voice.program });
    return track.id;
  }
  return editor.insertTrack(editor.tracks.indexOf(track) + 1, {
    name: part.name,
    instrumentProgram: voice.program,
    ...(drums ? { isPercussion: true } : {}),
    color: part.color,
    nameAutoGenerated: false,
  });
}

/** Bounce the roll to EDIT, every part with notes. Resolves null when no part has notes. */
export async function bounceRollToEditor(deps: RollBounceDeps): Promise<RollBounceResult | null> {
  const roll = usePianoRollStore.getState();
  const { bpm, totalSteps } = roll;
  const all = rollTracksOf(roll);
  const parts = all.filter((t) => t.notes.length > 0);
  if (parts.length === 0) return null;
  const doc = roll.rollDocId;
  const one = all.length === 1;
  // The tempo in labels and names, to the hundredth (a detected 97.333… reads 97.33).
  const bpmText = String(Math.round(bpm * 100) / 100);
  const out: RollPartBounce[] = [];
  for (const part of parts) {
    const order = all.indexOf(part);
    // The editor plays a clip's notes once, so it gets the lane repeats written
    // out (sourcePianoRoll). The part's own notes, the document's meter map,
    // pickup, lanes and bends, and the part's record are copied beside them,
    // so re-editing later sees the exact same state.
    const fields = { ...rollClipFields({ ...roll, notes: part.notes }), sourceRollPart: rollPartRef(part, order, doc) };
    const noteCount = fields.sourcePianoRoll.length;
    const before = useEditorStore.getState();
    const link = partLinkOf(usePianoRollStore.getState(), part.id);
    const partSound = partVoice(part, link, before.clips, before.tracks, deps.global(), roll.voiceProgram);
    // The bank the roll plays the part's program in (lib/rollPartVoice): none on
    // the drum channel, where the kit is chosen by program, and none without a program.
    const bank = partSound.percussion || partSound.program === undefined ? 0 : cleanPartBank(part.bank);
    const voice: ClipVoice = { program: partSound.program, percussion: partSound.percussion, ...(bank > 0 ? { bank } : {}) };
    // Each note renders in its own lane, so a lane's pitch bend bends its notes in
    // the audio too, and at its step's seconds under the roll's tempo map, so a
    // ritardando is in the audio while every note stays on its bar line.
    const { blob, duration } = await deps.render(unrollLanes(part.notes, roll.lanes, totalSteps), bpm, totalSteps, {
      program: voice.program,
      ...(bank > 0 ? { bank } : {}),
      percussion: voice.percussion,
      bends: rollRenderBends(roll.bends, roll.lanes, totalSteps),
      ...(fields.sourceTempoMap ? { tempoMap: fields.sourceTempoMap } : {}),
    });
    // The part's own sound on its clip: its program, and the bank that program
    // is chosen in. A bank belongs to a program (lib/clipProgram clipBank), so a
    // part in a bank past 0 with no program of its own pins the program the roll
    // played it with; bank 0 clears a bank an earlier SAVE wrote.
    const ownSound: Partial<AudioClip> = {
      ...(part.program !== null ? { instrumentProgram: part.program } : bank > 0 ? { instrumentProgram: voice.program } : {}),
      instrumentBank: bank > 0 ? bank : undefined,
    };
    const { peaks } = await deps.computePeaks(blob, 240);
    const editor = useEditorStore.getState();
    const label = `roll_${bpmText}bpm_${noteCount}n`;
    const existing = link ? editor.clips.find((c) => c.id === link) : undefined;
    if (existing) {
      const trackId = trackOfItsKind(existing, part, voice);
      useEditorStore.getState().updateClip(existing.id, {
        ...(trackId !== existing.trackId ? { trackId } : {}),
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        durationSec: duration,
        offsetIntoSource: 0,
        peaks,
        ...fields,
        // A part with a program of its own puts it on its clip, over its track's, with its bank.
        ...ownSound,
        ...renderedVoiceFields(voice),
        sourceKind: 'piano-roll',
        label: existing.label.startsWith('roll_') ? label : existing.label,
      });
      out.push({ partId: part.id, kind: 'updated', clipId: existing.id, duration, noteCount });
    } else {
      // No clip, or the one the part was bound to is gone: a new track holds the
      // part's voice (its own, the roll's or the picker's, as partVoice found).
      // A roll of one part with its default name keeps the name and colour the
      // roll has always given its track.
      const plain = one && isDefaultPartName(part.name);
      const trackId = editor.addTrack({
        name: plain ? `Piano ${bpmText} BPM` : part.name,
        instrumentProgram: voice.program,
        ...(isPercussionPart(part) ? { isPercussion: true } : {}),
        // A part's name is the track's, never replaced by the clip's label as an automatic name is.
        ...(plain ? {} : { color: part.color, nameAutoGenerated: false }),
        ...(part.mute ? { mute: true } : {}),
      });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? part.color;
      const clipId = editor.addClipToTrack({
        trackId,
        label,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        offsetIntoSource: 0,
        durationSec: duration,
        startSec: 0,
        color: trackColor,
        sourceKind: 'piano-roll',
        ...fields,
        // A bank past 0 rides on the clip with the program it is chosen in.
        ...(bank > 0 ? ownSound : {}),
        ...renderedVoiceFields(voice),
      });
      editor.cachePeaks(clipId, peaks);
      // Bind the part to its new clip so the next SAVE updates it in place.
      usePianoRollStore.getState().bindPartClip(part.id, clipId);
      out.push({ partId: part.id, kind: 'created', clipId, duration, noteCount });
    }
    deps.onPart?.(out.length, parts.length, part);
  }
  const active = out.find((p) => p.partId === roll.activeTrackId) ?? out[0];
  return {
    kind: out.some((p) => p.kind === 'created') ? 'created' : 'updated',
    clipId: active.clipId,
    duration: out.reduce((m, p) => Math.max(m, p.duration), 0),
    noteCount: out.reduce((n, p) => n + p.noteCount, 0),
    parts: out,
  };
}
