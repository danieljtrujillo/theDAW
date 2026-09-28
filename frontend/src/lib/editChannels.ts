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
  /**
   * Channels the track needs: one, plus one for each lane of its clips that
   * bends (a pitch wheel bends a whole channel, lib/pitchBend laneChannels).
   * Absent: one. A percussion track always takes one, the drum channel.
   */
  channels?: number;
}

export interface EditChannelPlan {
  /** Global channel (bank * 16 + local) by track id: the track's first channel. */
  channelOf: Map<string, number>;
  /**
   * Every channel of each track, first channel first. A track whose lanes bend
   * holds one channel per bent lane after its first (EditChannelTrack.channels).
   */
  channelsOf: Map<string, number[]>;
  /** How many banks the plan uses. */
  banks: number;
  /** Tracks past the last bank, which get no channel. */
  dropped: string[];
}

export const bankOfChannel = (channel: number): number => Math.floor(channel / EDIT_BANK_CHANNELS);
export const localChannel = (channel: number): number => channel % EDIT_BANK_CHANNELS;

/** The global channel of the `i`-th slot of the melodic pool. */
const melodicSlot = (i: number): number =>
  Math.floor(i / MELODIC_BANK_CHANNELS.length) * EDIT_BANK_CHANNELS + MELODIC_BANK_CHANNELS[i % MELODIC_BANK_CHANNELS.length];

/**
 * Channels for each track, in the order given: one per track, or as many as a
 * melodic track asks for (`channels`), taken one after another from the
 * melodic pool, so a track's channels can run from one bank into the next.
 * Each of a track's channels feeds that track's strip, so crossing a bank
 * changes nothing it sounds through. A track whose channels do not all fit is
 * dropped and plays its bounce; it takes nothing from the pool, so a later
 * track that fits still gets its channels.
 */
export function planEditChannels(tracks: readonly EditChannelTrack[], maxBanks = MAX_EDIT_BANKS): EditChannelPlan {
  const channelOf = new Map<string, number>();
  const channelsOf = new Map<string, number[]>();
  const dropped: string[] = [];
  let melodic = 0;
  let percussion = 0;
  let banks = 0;
  for (const t of tracks) {
    if (channelOf.has(t.id)) continue;
    let chans: number[];
    if (t.percussion) {
      if (percussion >= maxBanks) {
        dropped.push(t.id);
        continue;
      }
      chans = [percussion * EDIT_BANK_CHANNELS + DRUM_CHANNEL];
      percussion += 1;
    } else {
      const asked = Math.round(t.channels ?? 1);
      const want = Math.max(1, Math.min(MELODIC_BANK_CHANNELS.length, Number.isFinite(asked) ? asked : 1));
      if (Math.floor((melodic + want - 1) / MELODIC_BANK_CHANNELS.length) >= maxBanks) {
        dropped.push(t.id);
        continue;
      }
      chans = Array.from({ length: want }, (_, i) => melodicSlot(melodic + i));
      melodic += want;
    }
    channelOf.set(t.id, chans[0]);
    channelsOf.set(t.id, chans);
    for (const ch of chans) banks = Math.max(banks, bankOfChannel(ch) + 1);
  }
  return { channelOf, channelsOf, banks, dropped };
}
