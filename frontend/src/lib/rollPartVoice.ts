/**
 * rollPartVoice — the voice each of the roll's parts plays with, read from the
 * live stores: the roll's parts and links, EDIT's clips and tracks, and the
 * global instrument picker. The rule itself is lib/rollTracks partVoice.
 *
 * Every audition goes through here: the scheduler's notes, a click on the
 * grid or the keyboard, the arpeggiator and the Vocal2MIDI previews, so a part
 * always sounds as its own instrument.
 */
import { useEditorStore } from '../state/editorStore';
import { activeTrackOf, partLinkOf, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore';
import type { ClipVoice } from './clipProgram';
import { partVoice } from './rollTracks';
import { getGlobalVoice } from './soundfontEngine';

/** A part's voice with the bank its program is selected in. */
export type PartVoice = ClipVoice & { bank: number };

/** The voice of part `partId` (the active part when left out). */
export function rollPartVoice(partId?: string): PartVoice {
  const roll = usePianoRollStore.getState();
  const part = (partId ? roll.tracks.find((t) => t.id === partId) : undefined) ?? activeTrackOf(roll);
  const { clips, tracks } = useEditorStore.getState();
  const voice = partVoice(part, partLinkOf(roll, part.id), clips, tracks, getGlobalVoice(), roll.voiceProgram);
  return { ...voice, bank: voice.percussion ? 0 : part.bank };
}

/** Every part's voice, by part id: what one scheduler tick plays with. */
export function rollPartVoices(): Map<string, PartVoice> {
  const roll = usePianoRollStore.getState();
  const { clips, tracks } = useEditorStore.getState();
  const global = getGlobalVoice();
  const out = new Map<string, PartVoice>();
  for (const part of rollTracksOf(roll)) {
    const voice = partVoice(part, partLinkOf(roll, part.id), clips, tracks, global, roll.voiceProgram);
    out.set(part.id, { ...voice, bank: voice.percussion ? 0 : part.bank });
  }
  return out;
}
