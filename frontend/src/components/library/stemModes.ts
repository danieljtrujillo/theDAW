/**
 * What each stem-separation mode actually produces.
 *
 * Pure model, no DOM and no store: the dialog renders from it and the test
 * pins it. The numbers here are the *wire* values the backend expects
 * (`settings.default_count` stays 2 | 4 | 6 | 12) — they are NOT a promise
 * about how many files come back. Mode 12 runs the 6-stem split and then
 * replaces the drum mix with five LARSNET drum parts, so it yields ten.
 *
 * Source of truth for the roles and the quality knobs is the separator
 * service (`backend/main.py`, `_QUALITY_PRESETS` and the 12-stem branch).
 */

/** Wire value sent to the separator, and stored as `settings.default_count`. */
export type StemModeValue = 2 | 4 | 6 | 12;

/** Quality tier sent to the separator, and stored as `settings.quality`. */
export type QualityValue = 'fast' | 'balanced' | 'hq';

export interface StemMode {
  /** Wire value. Never renamed: the backend contract depends on it. */
  readonly value: StemModeValue;
  /** Button label. Says what you get, not what the wire value is called. */
  readonly label: string;
  /** One line naming every role in `roles`, in output order. */
  readonly hint: string;
  /** Exact output roles, lower case, in output order. No duplicates. */
  readonly roles: readonly string[];
  /** Number of audio files produced. Equals `roles.length`. */
  readonly partCount: number;
  /** Caveat shown under the option, when the mode has one. */
  readonly notice?: string;
}

export interface QualityTier {
  readonly value: QualityValue;
  readonly label: string;
  /** Relative cost only — no wall-clock estimate has been measured. */
  readonly hint: string;
  /**
   * The knobs this tier sets, per mode family. The model swap applies to the
   * 4-stem mode alone; 2, 6 and 12 run fixed models (mdx_extra / htdemucs_6s)
   * and only the pass count and overlap move.
   */
  readonly detail: {
    readonly fourStem: string;
    readonly fixedModel: string;
  };
}

const freezeRoles = (roles: string[]): readonly string[] => Object.freeze(roles);

export const STEM_MODES: readonly StemMode[] = Object.freeze([
  Object.freeze({
    value: 2,
    label: '2 stems',
    hint: 'Vocals + instrumental',
    roles: freezeRoles(['vocals', 'instrumental']),
    partCount: 2,
  }),
  Object.freeze({
    value: 4,
    label: '4 stems',
    hint: 'Vocals, drums, bass, other',
    roles: freezeRoles(['vocals', 'drums', 'bass', 'other']),
    partCount: 4,
  }),
  Object.freeze({
    value: 6,
    label: '6 stems',
    hint: 'Vocals, drums, bass, guitar, piano, other',
    roles: freezeRoles(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']),
    partCount: 6,
  }),
  Object.freeze({
    value: 12,
    label: 'Detailed · 10 parts',
    hint: 'Vocals, bass, guitar, piano, other + kick, snare, toms, hi-hat, cymbals (drum mix is replaced by its parts)',
    roles: freezeRoles([
      'vocals',
      'bass',
      'guitar',
      'piano',
      'other',
      'kick',
      'snare',
      'toms',
      'hi-hat',
      'cymbals',
    ]),
    partCount: 10,
    notice:
      "Drum parts use LARSNET weights (CC BY-NC 4.0, non-commercial) and are level-normalized, so they won't sum exactly to the original drums.",
  }),
] satisfies StemMode[]);

export const QUALITY_TIERS: readonly QualityTier[] = Object.freeze([
  Object.freeze({
    value: 'fast',
    label: 'Fast',
    hint: 'Fastest',
    detail: Object.freeze({
      fourStem: 'htdemucs, shifts 0, overlap 0.25',
      fixedModel: 'shifts 0, overlap 0.25',
    }),
  }),
  Object.freeze({
    value: 'balanced',
    label: 'Balanced',
    hint: 'Slower',
    detail: Object.freeze({
      fourStem: 'htdemucs_ft, shifts 1, overlap 0.25',
      fixedModel: 'shifts 1, overlap 0.25',
    }),
  }),
  Object.freeze({
    value: 'hq',
    label: 'HQ',
    hint: 'Slowest',
    detail: Object.freeze({
      fourStem: 'htdemucs_ft, shifts 2, overlap 0.5',
      fixedModel: 'shifts 2, overlap 0.5',
    }),
  }),
] satisfies QualityTier[]);

/** The mode for a wire value. Throws RangeError if the value is not a mode. */
export function stemMode(value: StemModeValue): StemMode {
  const mode = STEM_MODES.find((m) => m.value === value);
  if (!mode) throw new RangeError(`unknown stem mode: ${String(value)}`);
  return mode;
}

/**
 * The exact output roles for a wire value, in output order.
 *
 * Throws RangeError rather than returning an empty list, so a bad value is a
 * loud bug instead of a dialog that silently promises nothing.
 */
export function expectedRoles(value: StemModeValue): readonly string[] {
  return stemMode(value).roles;
}

/** The knobs a tier sets for a given mode, picking the right mode family. */
export function qualityDetail(tier: QualityTier, stems: StemModeValue): string {
  return stems === 4 ? tier.detail.fourStem : tier.detail.fixedModel;
}
