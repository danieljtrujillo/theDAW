/**
 * Compatibility exports for older audio components.
 *
 * The canonical MIDI implementation lives in `../lib/midi`. Keeping this file as
 * a thin re-export avoids duplicate parser drift where the editor timeline used
 * this module and rejected valid library MIDI files that `lib/midi` could parse.
 */

export type { MidiFileData, MidiNote, MidiTrack } from '../lib/midi';
export { encodeMidi as buildMidiFile, downloadMidi, parseMidi } from '../lib/midi';