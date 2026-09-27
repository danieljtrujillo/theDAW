/**
 * editChannels — the live soundfont channel each EDIT track's MIDI plays on.
 *
 * EDIT plays its MIDI through synths of its own (soundfontEngine's EDIT banks),
 * sixteen channels to a bank. The piano roll's lane channels, the arpeggiator's
 * channel and the hardware keyboard's channel all live on the preview synth,
 * so none of them is ever in this pool.
 *
 * On every bank the General MIDI drum channel (local channel 9) belongs to
 * percussion tracks only. Melodic tracks take the other fifteen channels of
 * bank 0, then of bank 1, and so on; the n-th percussion track takes the drum
 * channel of bank n. A channel number here is global: bank * 16 + local.
 *
 * Why banks and not `addNewChannel` on one synth: a SpessaSynth worklet has
 * sixteen dry outputs, and a channel past fifteen shares the output of channel
 * `n % 16` (spessasynth_lib `connectChannel`: "will be rolled over if value is
 * greater than 15"). Two tracks on one output cannot run through two track
 * strips, so each group of sixteen gets a synth whose outputs are its own.
 *
 * Pure, so node tests load it.
 */

/** Channels on one EDIT bank. */
export const EDIT_BANK_CHANNELS = 16;
/** The General MIDI drum channel, zero-based, on every bank. */
export const DRUM_CHANNEL = 9;
/** The most EDIT banks: 120 melodic tracks and 8 percussion tracks. */
export const MAX_EDIT_BANKS = 8;
/** A bank's channels a melodic track may take, in the order tracks take them. */
export const MELODIC_BANK_CHANNELS: readonly number[] = Object.freeze(
  Array.from({ length: EDIT_BANK_CHANNELS }, (_, i) => i).filter((ch) => ch !== DRUM_CHANNEL),
);

export interface EditChannelTrack {
  id: string;
  percussion: boolean;
}

export interface EditChannelPlan {
  /** Global channel (bank * 16 + local) by track id. */
  channelOf: Map<string, number>;
  /** How many banks the plan uses. */
  banks: number;
  /** Tracks past the last bank, which get no channel. */
  dropped: string[];
}

export const bankOfChannel = (channel: number): number => Math.floor(channel / EDIT_BANK_CHANNELS);
export const localChannel = (channel: number): number => channel % EDIT_BANK_CHANNELS;

/** One channel per track, in the order given. */
export function planEditChannels(tracks: readonly EditChannelTrack[], maxBanks = MAX_EDIT_BANKS): EditChannelPlan {
  const channelOf = new Map<string, number>();
  const dropped: string[] = [];
  let melodic = 0;
  let percussion = 0;
  let banks = 0;
  for (const t of tracks) {
    if (channelOf.has(t.id)) continue;
    const bank = t.percussion ? percussion : Math.floor(melodic / MELODIC_BANK_CHANNELS.length);
    if (bank >= maxBanks) {
      dropped.push(t.id);
      continue;
    }
    const local = t.percussion ? DRUM_CHANNEL : MELODIC_BANK_CHANNELS[melodic % MELODIC_BANK_CHANNELS.length];
    if (t.percussion) percussion += 1;
    else melodic += 1;
    channelOf.set(t.id, bank * EDIT_BANK_CHANNELS + local);
    banks = Math.max(banks, bank + 1);
  }
  return { channelOf, banks, dropped };
}
