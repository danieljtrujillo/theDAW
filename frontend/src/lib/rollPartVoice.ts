/**
 * rollPartVoice — the voice each of the roll's parts plays with, read from the
 * live stores: the roll's parts and links, EDIT's clips and tracks, and the
 * global instrument picker. The rule itself is lib/rollTracks partVoice.
 *
 * Every audition goes through here: the scheduler's notes, a click on the
 * grid or the keyboard, the arpeggiator and the Vocal2MIDI previews, so a part
 * always sounds as its own instrument.
 *
 * A part that plays through a VST3 instrument (RollTrack `vstInstrument`)
 * carries `vst` while its plugin can play (state/rollInstruments
 * rollVstVoiceOf): the plugin's entry, how it hears articulations and the
 * part's MIDI channel. Its program is the one it plays whenever the plugin
 * cannot, so a part is never silent.
 */
import { useEditorStore } from '../state/editorStore';
import { activeTrackOf, partLinkOf, rollTracksOf, usePianoRollStore, type RollTrack } from '../state/pianoRollStore';
import { rollVstVoiceOf } from '../state/rollInstruments';
import type { ClipVoice } from './clipProgram';
import type { Vst3SwitchMode } from './articulationMap';
import { partVoice } from './rollTracks';
import { getGlobalVoice } from './soundfontEngine';

/** A part's voice with the bank its program is selected in, and the VST3 instrument it plays through now. */
export type PartVoice = ClipVoice & { bank: number; vst?: { entryId: string; mode: Vst3SwitchMode; channel: number | null } };

const withVst = (part: RollTrack, voice: ClipVoice & { bank: number }): PartVoice => {
  const vst = rollVstVoiceOf(part);
  return vst ? { ...voice, vst: { ...vst, channel: part.channel } } : voice;
};

/** The voice of part `partId` (the active part when left out). */
export function rollPartVoice(partId?: string): PartVoice {
  const roll = usePianoRollStore.getState();
  const part = (partId ? roll.tracks.find((t) => t.id === partId) : undefined) ?? activeTrackOf(roll);
  const { clips, tracks } = useEditorStore.getState();
  const voice = partVoice(part, partLinkOf(roll, part.id), clips, tracks, getGlobalVoice(), roll.voiceProgram);
  return withVst(part, { ...voice, bank: voice.percussion ? 0 : part.bank });
}

/** Every part's voice, by part id: what one scheduler tick plays with. */
export function rollPartVoices(): Map<string, PartVoice> {
  const roll = usePianoRollStore.getState();
  const { clips, tracks } = useEditorStore.getState();
  const global = getGlobalVoice();
  const out = new Map<string, PartVoice>();
  for (const part of rollTracksOf(roll)) {
    const voice = partVoice(part, partLinkOf(roll, part.id), clips, tracks, global, roll.voiceProgram);
    out.set(part.id, withVst(part, { ...voice, bank: voice.percussion ? 0 : part.bank }));
  }
  return out;
}
