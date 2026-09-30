/**
 * Project-meter conversions between the editor and the persisted formats.
 *
 * Dependency-free at runtime (the one import is type-only), so it can be tested
 * under tsx and imported by any load/save path without dragging in the audio
 * graph. `editorStore` re-exports `validTimeSignature` from here, so there is
 * exactly one definition of what a usable meter is.
 */
import type { TimeSignature } from '../state/editorStore';

/** The denominators a meter may use — note values, so powers of two only. */
const TIME_SIG_DENOMINATORS = [1, 2, 4, 8, 16, 32];

/** A meter the editor can actually bar out, or null. Refused rather than
 *  clamped: substituting a different meter for the one that was asked for would
 *  silently re-bar the whole song. */
export const validTimeSignature = (num: number, den: number): TimeSignature | null => {
  if (!Number.isInteger(num) || num < 1 || num > 32) return null;
  if (!TIME_SIG_DENOMINATORS.includes(den)) return null;
  return { num, den };
};

/** A `.tasmo` / DAW meter (a `[num, den]` pair) as the editor's TimeSignature.
 *  A document written before the field existed — or carrying a meter the editor
 *  cannot bar out — is 4/4: the format's own documented default, and the only
 *  honest reading of a project that never recorded one. */
export const meterFromTasmo = (pair: readonly number[] | null | undefined): TimeSignature =>
  (Array.isArray(pair) && pair.length >= 2 ? validTimeSignature(pair[0], pair[1]) : null) ?? {
    num: 4,
    den: 4,
  };

/** The editor's TimeSignature as the `.tasmo` `time_signature` pair. */
export const meterToTasmo = (meter: TimeSignature): [number, number] => [meter.num, meter.den];
