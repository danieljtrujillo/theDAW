/**
 * The EDIT timeline's "Add to track" menu, as data: which entries the menu
 * lists for a given click target, in what order, which of them are disabled
 * and why. Pure — no React, no DOM, no stores — so the tsx test runs it under
 * plain node (the same shape as score/exportMenuModel.ts).
 *
 * What "add ANYTHING to a track" honestly means here: the editor store knows
 * exactly two clip kinds, `ClipSourceKind = 'audio' | 'piano-roll'`
 * (editorStore.ts), so every insert is either an audio Blob or a MIDI note
 * list. Stems, Chimera renders, generated takes, DAW-imported clips and mic
 * recordings are all `'audio'` clips that differ only in where the Blob came
 * from; video and image library entries have no clip kind at all and cannot go
 * on a track. So the menu is two kinds x two sources, plus the two things the
 * store can already do to a lane without fetching anything (paste the clip
 * clipboard, make an empty track).
 *
 * The target is resolved from the click the same way a drop is: the lane under
 * the pointer, or `trackId: null` when the click landed below every track — in
 * which case every add creates a new track, exactly like dropping there.
 */

/** Where the thing being added comes from. */
export type AddSource = 'library' | 'system';

/** Which of the store's two clip kinds the entry produces. */
export type AddKind = 'audio' | 'midi';

export type AddToTrackEntryId =
  | 'audio-library'
  | 'audio-system'
  | 'midi-library'
  | 'midi-system'
  | 'paste'
  | 'new-track';

/** The lane + time a right-click resolved to. */
export interface AddToTrackTarget {
  /** The track under the pointer, or null when the click was below every track. */
  trackId: string | null;
  /** That track's name, for the menu's group header. Null with a null trackId. */
  trackName: string | null;
  /** Snapped timeline seconds the clip will start at. */
  atSec: number;
}

/** What the app can actually offer right now. Everything here is read from a
 *  real store or index, never assumed. */
export interface AddToTrackCapabilities {
  /** Placeable library entries — audio takes only, since video and image
   *  entries are not clips — or null while the library store has not finished
   *  its first load. Null keeps the entry offered: "not loaded" is not "empty",
   *  and the library loads on an idle callback after boot, so a right-click in
   *  the first second would otherwise read as an empty library. */
  libraryAudioCount: number | null;
  /** Rows in the library MIDI index, or null while it has not been read yet —
   *  null keeps the entry offered, for the same reason. */
  libraryMidiCount: number | null;
  /** Clips sitting on the editor's clip clipboard (Ctrl+C / Cut). */
  clipboardClipCount: number;
  /** Tracks in the project — paste needs somewhere to land. */
  trackCount: number;
}

export interface AddToTrackEntry {
  id: AddToTrackEntryId;
  label: string;
  /** The clip kind this produces; null for entries that add no clip. */
  kind: AddKind | null;
  /** Where the bytes come from; null for entries that fetch nothing. */
  source: AddSource | null;
  enabled: boolean;
  /** Hover text — the REASON when the entry is disabled. */
  title: string;
  /** The same reason in two or three words, for a disabled row's always-visible
   *  badge. Null when the entry is enabled. A disabled menu item is
   *  `pointer-events: none`, so `title` alone never reaches the user on the one
   *  row where the explanation matters — this is what actually gets shown. */
  shortReason: string | null;
  /** True when choosing this lands on a NEW track rather than the clicked one. */
  createsTrack: boolean;
}

/** The header row above the add entries. Says where the clip is going, so the
 *  menu never repeats the old lie that "add to track" adds to the track you
 *  clicked while actually making a new one. */
export function addToTrackGroupLabel(target: AddToTrackTarget): string {
  return target.trackId ? `Add to ${target.trackName || 'this track'}` : 'Add to a new track';
}

const onTrackSuffix = (target: AddToTrackTarget): string =>
  target.trackId ? `onto ${target.trackName || 'this track'}` : 'onto a new track';

const atSuffix = (target: AddToTrackTarget): string => `at ${target.atSec.toFixed(2)}s`;

/** No audio in the library is a real, common state on a fresh install; say what
 *  fixes it rather than greying the row out with no explanation. */
const NO_LIBRARY_AUDIO =
  'No audio in the library yet — generate a take or import a file first';
const NO_LIBRARY_MIDI =
  'No MIDI in the library yet — convert a take to MIDI, or use MIDI from System';
const NO_CLIPBOARD = 'Copy or cut a clip first (Ctrl+C / Ctrl+X)';
const NO_TRACKS = 'There is no track to paste onto yet';

/** The badge forms of the four reasons above. Short enough to sit beside the
 *  label without squeezing it out of a menu that caps at 22rem. */
const SHORT_NO_LIBRARY_AUDIO = 'library empty';
const SHORT_NO_LIBRARY_MIDI = 'no MIDI yet';
const SHORT_NO_CLIPBOARD = 'nothing copied';
const SHORT_NO_TRACKS = 'no tracks';

export function buildAddToTrackMenu(
  target: AddToTrackTarget,
  caps: AddToTrackCapabilities,
): AddToTrackEntry[] {
  const createsTrack = target.trackId === null;
  const where = `${onTrackSuffix(target)} ${atSuffix(target)}`;
  // null = the index has not been read; only a KNOWN zero disables a row.
  const hasLibraryAudio = caps.libraryAudioCount === null || caps.libraryAudioCount > 0;
  const hasLibraryMidi = caps.libraryMidiCount === null || caps.libraryMidiCount > 0;
  const canPaste = caps.clipboardClipCount > 0 && (target.trackId !== null || caps.trackCount > 0);

  const entries: AddToTrackEntry[] = [
    {
      id: 'audio-library',
      label: 'Audio from Library…',
      kind: 'audio',
      source: 'library',
      enabled: hasLibraryAudio,
      title: hasLibraryAudio
        ? `Browse library takes and stems, and place one ${where}`
        : NO_LIBRARY_AUDIO,
      shortReason: hasLibraryAudio ? null : SHORT_NO_LIBRARY_AUDIO,
      createsTrack,
    },
    {
      id: 'audio-system',
      label: 'Audio from System…',
      kind: 'audio',
      source: 'system',
      enabled: true,
      // Every system pick is imported to the library first, exactly like a
      // desktop drop, so the clip is indistinguishable from a dropped one.
      title: `Pick audio files from this computer — they import to the library, then land ${where}`,
      shortReason: null,
      createsTrack,
    },
    {
      id: 'midi-library',
      label: 'MIDI from Library…',
      kind: 'midi',
      source: 'library',
      enabled: hasLibraryMidi,
      title: hasLibraryMidi
        ? `Browse library MIDI and place it as an editable clip ${where}`
        : NO_LIBRARY_MIDI,
      shortReason: hasLibraryMidi ? null : SHORT_NO_LIBRARY_MIDI,
      createsTrack,
    },
    {
      id: 'midi-system',
      label: 'MIDI from System…',
      kind: 'midi',
      source: 'system',
      enabled: true,
      title: `Pick a .mid file from this computer and place it as an editable clip ${where}`,
      shortReason: null,
      createsTrack,
    },
    {
      id: 'paste',
      label:
        caps.clipboardClipCount > 1
          ? `Paste ${caps.clipboardClipCount} clips here`
          : 'Paste clip here',
      kind: null,
      source: null,
      enabled: canPaste,
      // Paste never creates a track, so it must NOT borrow `where` — below all
      // lanes the clips go back on the tracks they were cut from, and saying
      // "onto a new track" there would be the same lie the old menu told.
      title: canPaste
        ? target.trackId
          ? `Paste the clipboard onto ${target.trackName || 'this track'} ${atSuffix(target)}`
          : `Paste the clipboard ${atSuffix(target)}, on the tracks it came from`
        : caps.clipboardClipCount === 0
          ? NO_CLIPBOARD
          : NO_TRACKS,
      shortReason: canPaste
        ? null
        : caps.clipboardClipCount === 0
          ? SHORT_NO_CLIPBOARD
          : SHORT_NO_TRACKS,
      createsTrack: false,
    },
    {
      id: 'new-track',
      label: 'New empty track',
      kind: null,
      source: null,
      enabled: true,
      title: 'Add an empty track at the bottom of the timeline',
      shortReason: null,
      createsTrack: true,
    },
  ];
  return entries;
}

/** The four add-something entries, in menu order — the group the "Add to
 *  track" header covers. Used by the track-header menu, which offers the same
 *  sources but not paste / new-track (it already has a track). */
export const ADD_SOURCE_ENTRY_IDS: readonly AddToTrackEntryId[] = [
  'audio-library',
  'audio-system',
  'midi-library',
  'midi-system',
];

export const isAddSourceEntry = (entry: AddToTrackEntry): boolean =>
  ADD_SOURCE_ENTRY_IDS.includes(entry.id);
