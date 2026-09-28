/**
 * editBankBanks — which of the user's sound banks each EDIT bank synth needs.
 *
 * Each EDIT bank is a SpessaSynth worklet of its own (lib/editChannels), and
 * SpessaSynth 4.3 gives every worklet its own parsed copy of every sound bank
 * it is handed (its processor parses the buffer on `addSoundBank`, and no
 * call shares a parsed bank between processors). So an EDIT bank loads only
 * the user banks its tracks select: the bank a clip's voice selects (its
 * clip's, track's or the picker's program, lib/clipProgram clipVoice, or its
 * roll part's when it plays with none, lib/arrangementMidi clipBankSelect),
 * and for a drum track, a user bank holding a kit at its program that the
 * bundled bank has none at. An external-only track sounds on no synth.
 *
 * Pure, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { bankForSelect, type SoundBank } from './bankRegistry';
import { clipBankSelect } from './arrangementMidi';
import { clipVoice, isExternalOnly, type GlobalVoice } from './clipProgram';
import { bankOfChannel } from './editChannels';

export function userBanksByEditBank(
  channelsOf: ReadonlyMap<string, readonly number[]>,
  clips: readonly AudioClip[],
  tracks: readonly EditorTrack[],
  global: GlobalVoice,
  banks: readonly SoundBank[],
): Array<Set<string>> {
  const out: Array<Set<string>> = [];
  const users = banks.filter((b) => b.kind === 'user');
  if (!users.length) return out;
  const bundledKits = new Set(banks.filter((b) => b.kind === 'bundled').flatMap((b) => b.presets.filter((p) => p.drum).map((p) => p.program)));
  const trackById = new Map(tracks.map((t): [string, EditorTrack] => [t.id, t]));
  const need = (trackId: string, bankId: string) => {
    for (const ch of channelsOf.get(trackId) ?? []) {
      const i = bankOfChannel(ch);
      while (out.length <= i) out.push(new Set());
      out[i].add(bankId);
    }
  };
  for (const clip of clips) {
    if (clip.muted) continue;
    const track = trackById.get(clip.trackId);
    if (!track || isExternalOnly(track) || !channelsOf.has(track.id)) continue;
    const voice = clipVoice(clip, track, global);
    if (voice.percussion) {
      const program = voice.program;
      if (program === undefined || bundledKits.has(program)) continue;
      for (const b of users) if (b.presets.some((p) => p.drum && p.program === program)) need(track.id, b.id);
      continue;
    }
    const { bank } = clipBankSelect(voice, clip.sourceRollPart);
    const { bankId } = bankForSelect(bank, users);
    if (users.some((b) => b.id === bankId)) need(track.id, bankId);
  }
  return out;
}
