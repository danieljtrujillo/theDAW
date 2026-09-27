/**
 * The piano roll's note clock: its ticks to the quarter, its grid and its
 * shortest note. `state/pianoRollStore` re-exports all three, which is where
 * most code reads them.
 *
 * A module of its own with no imports, so a pure module can read the clock
 * without loading the roll's store: `lib/takeNotes`, which `lib/midiCapture`'s
 * store-free core converts its takes with.
 */

/**
 * Ticks to the quarter note. 960 is divisible by 3, 4, 5, 6, 8, 12, 16, 32 and
 * 64, so triplets, quintuplets and 64ths all land on whole ticks — which is why
 * finer quantise does not need another model change.
 */
export const PPQ = 960;

/** The roll's own grid: sixteenths, so four steps to the beat. */
export const ROLL_STEPS_PER_BEAT = 4;

/** The shortest note the model holds at all: one tick. */
export const MIN_NOTE_TICKS = 1;
