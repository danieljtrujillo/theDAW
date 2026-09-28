import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FolderOpen, Search, Star, Music, FileMusic, Rows3 } from 'lucide-react';
import { sendMidiIdToTarget } from '../../lib/sendToTargets';
import { SHEET_ACCEPT } from '../../lib/sheetImportClient';
import { KnownFilesMenu } from '../ui/KnownFilesMenu';
import {
  cachedLibraryMidi,
  loadLibraryMidi,
  midiRowLabel as rowLabel,
  type LibraryMidiRow as MidiRow,
} from '../../lib/libraryIndex';
import { DockFlyout, FLYOUT_CARD, RAIL_GLYPH, RailKey } from './midiDockKit';

const MIDI_ACCEPT_LIST = '.mid,.midi,audio/midi';
const MIDI_RECENT_ID = 'piano-roll-import-midi-recent';
const SHEET_RECENT_ID = 'piano-roll-import-sheet-recent';
const TRACKS_RECENT_ID = 'piano-roll-import-tracks-recent';
// KnownFilesMenu drops the mime entries, so the accept lists pass as they are.
const MIDI_RECENT_EXTS = MIDI_ACCEPT_LIST.split(',');
const SHEET_RECENT_EXTS = SHEET_ACCEPT.split(',');

/** True while one of the flyout's Recent lists is open. Those lists portal to
 *  document.body, so a click on one of their rows lands outside the flyout. */
const recentListOpen = (): boolean =>
  [MIDI_RECENT_ID, SHEET_RECENT_ID, TRACKS_RECENT_ID].some(
    (id) => document.getElementById(id)?.getAttribute('aria-expanded') === 'true',
  );

/**
 * IMPORT control for the Piano Roll: the IMPORT key in the MIDI dock's action
 * rail, with one flyout and these sources:
 *   - "MIDI file on disk…" opens the OS file picker (hidden <input type=file>).
 *   - "Sheet music…" imports MusicXML / ABC / kern through the backend.
 *   - "As EDIT tracks" puts a MIDI file's parts on EDIT tracks of their own,
 *     one per part on its own instrument (lib/midiImportTracks).
 *   - "Recent" beside each lists MIDI and sheet files the app saved or downloaded.
 *   - the library list loads any converted MIDI straight into the roll.
 */
export const MidiImportPopover: React.FC<{
  onImportFile: (file: File) => void;
  /** Optional: import a notation file (MusicXML/ABC/kern) via the backend. */
  onImportSheetFile?: (file: File) => void;
  /** Optional: put a MIDI file's parts on EDIT tracks, one per part. */
  onImportTracksFile?: (file: File) => void;
}> = ({ onImportFile, onImportSheetFile, onImportTracksFile }) => {
  const [open, setOpen] = useState(false);
  const [midis, setMidis] = useState<MidiRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const keyRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLInputElement>(null);
  const tracksRef = useRef<HTMLInputElement>(null);

  // The index (fetch, cache, row label) is shared with the LibraryPicker and
  // the LIBRARY tab, so a row reads the same wherever it is listed.
  const loadMidis = useCallback(async () => {
    setLoading(true);
    try {
      setMidis(await loadLibraryMidi({ force: true }));
    } catch {
      // loadLibraryMidi already wrote the LOG line; fall back to whatever is
      // cached rather than blanking a list the user is looking at.
      setMidis(cachedLibraryMidi() ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the library list the first time the popover opens.
  useEffect(() => {
    if (open && midis === null && !loading) void loadMidis();
  }, [open, midis, loading, loadMidis]);

  const filtered = useMemo(() => {
    const list = midis || [];
    const q = query.trim().toLowerCase();
    const matched = q ? list.filter((m) => rowLabel(m).toLowerCase().includes(q)) : list;
    // Favorites first, then alphabetical by label.
    return [...matched].sort((a, b) => {
      const fav = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
      return fav !== 0 ? fav : rowLabel(a).localeCompare(rowLabel(b));
    });
  }, [midis, query]);

  const pickLibraryMidi = (m: MidiRow) => {
    void sendMidiIdToTarget(String(m.id), 'piano-roll');
    setOpen(false);
  };

  // One handler per source kind, fed by the file input and the Recent list alike.
  const importMidiFiles = (files: File[]) => {
    const f = files[0];
    if (f) onImportFile(f);
    setOpen(false);
    keyRef.current?.focus();
  };

  const importSheetFiles = (files: File[]) => {
    const f = files[0];
    if (f && onImportSheetFile) onImportSheetFile(f);
    setOpen(false);
    keyRef.current?.focus();
  };

  const importTracksFiles = (files: File[]) => {
    const f = files[0];
    if (f && onImportTracksFile) onImportTracksFile(f);
    setOpen(false);
    keyRef.current?.focus();
  };

  // The flyout closes on an outside click, except one on an open Recent list's
  // rows; that list closes itself first and takes its own Escape.
  const closeFlyout = () => {
    if (!recentListOpen()) setOpen(false);
  };

  const sourceBtn =
    'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-xs bg-white/5 border-b border-b-transparent text-left text-[12px] font-semibold text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)] transition-shadow';

  return (
    <>
      {/* Hidden OS file picker, triggered by "MIDI file on disk…". */}
      <label htmlFor="piano-roll-import-midi" className="sr-only">MIDI file to import</label>
      <input
        ref={fileRef}
        type="file"
        id="piano-roll-import-midi"
        name="piano-roll-import-midi"
        accept={MIDI_ACCEPT_LIST}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          importMidiFiles(files);
        }}
      />

      {/* Hidden picker for notation files (parsed on the backend via music21). */}
      {onImportSheetFile && (
        <label htmlFor="piano-roll-import-sheet" className="sr-only">Sheet music file to import</label>
      )}
      {onImportSheetFile && (
        <input
          ref={sheetRef}
          type="file"
          id="piano-roll-import-sheet"
          name="piano-roll-import-sheet"
          accept={SHEET_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            importSheetFiles(files);
          }}
        />
      )}

      {/* Hidden picker for "As EDIT tracks": a MIDI file whose parts each get an EDIT track. */}
      {onImportTracksFile && (
        <label htmlFor="piano-roll-import-tracks" className="sr-only">MIDI file to import as EDIT tracks</label>
      )}
      {onImportTracksFile && (
        <input
          ref={tracksRef}
          type="file"
          id="piano-roll-import-tracks"
          name="piano-roll-import-tracks"
          accept={MIDI_ACCEPT_LIST}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            importTracksFiles(files);
          }}
        />
      )}

      <RailKey
        ref={keyRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="piano-roll-import-popover"
        aria-label="Import MIDI"
        description="Import a MIDI file from disk, from recent files or from the library"
        on={open}
        icon={<Upload className={RAIL_GLYPH} />}
        legend="Import"
      />

      <DockFlyout
        open={open}
        anchorRef={keyRef}
        onClose={closeFlyout}
        placement="right"
        floorSelector="[data-dock-floor]"
        id="piano-roll-import-popover"
        role="dialog"
        aria-label="Import MIDI"
        className={`w-72 p-2 flex flex-col gap-2 ${FLYOUT_CARD}`}
      >
        <div className="flex items-stretch gap-1">
          <button type="button" onClick={() => fileRef.current?.click()} className={sourceBtn} title="Import a MIDI file from disk" aria-label="Import a MIDI file from disk">
            <FolderOpen aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
            <span>File</span>
          </button>
          <KnownFilesMenu id={MIDI_RECENT_ID} exts={MIDI_RECENT_EXTS} label="Recent" name="Recent MIDI files" size="flyout" onFiles={importMidiFiles} />
        </div>

        {onImportSheetFile && (
          <div className="flex items-stretch gap-1">
            <button
              type="button"
              onClick={() => sheetRef.current?.click()}
              className={sourceBtn}
              title="Import sheet music: MusicXML, ABC or Humdrum kern"
              aria-label="Import sheet music: MusicXML, ABC or Humdrum kern"
            >
              <FileMusic aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
              <span>Sheet</span>
            </button>
            <KnownFilesMenu id={SHEET_RECENT_ID} exts={SHEET_RECENT_EXTS} label="Recent" name="Recent sheet music files" size="flyout" onFiles={importSheetFiles} />
          </div>
        )}

        {onImportTracksFile && (
          <div className="flex items-stretch gap-1">
            <button
              type="button"
              onClick={() => tracksRef.current?.click()}
              className={sourceBtn}
              title="Put a MIDI file into EDIT as tracks: one track per part, each on its own instrument, drums on a drum track"
              aria-label="Import a MIDI file into EDIT as tracks, one track per part"
            >
              <Rows3 aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
              <span>As EDIT tracks</span>
            </button>
            <KnownFilesMenu id={TRACKS_RECENT_ID} exts={MIDI_RECENT_EXTS} label="Recent" name="Recent MIDI files to import as EDIT tracks" size="flyout" onFiles={importTracksFiles} />
          </div>
        )}

        <div className="flex items-center gap-1.5 px-1 pt-0.5">
          <span className="text-[12px] font-display font-bold uppercase et-ink-3">From library</span>
          <div className="flex-1 h-px bg-white/10" />
        </div>

        <div className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded px-2">
          <Search aria-hidden="true" className="w-3 h-3 et-ink-3 shrink-0" />
          <label htmlFor="piano-roll-library-midi-search" className="sr-only">
            Search library MIDI
          </label>
          <input
            id="piano-roll-library-midi-search"
            name="piano-roll-library-midi-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="flex-1 min-w-0 bg-transparent border-none outline-none py-1 text-[12px] font-semibold text-zinc-200 placeholder:text-zinc-600"
          />
        </div>

        <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5 pr-0.5">
          {loading && (
            <span className="text-[12px] font-semibold et-ink-3 px-2 py-3 text-center">loading…</span>
          )}
          {!loading && filtered.length === 0 && (
            <span className="text-[12px] font-semibold et-ink-3 px-2 py-3 text-center">
              {midis && midis.length === 0 ? 'No library MIDI yet' : 'No matches'}
            </span>
          )}
          {!loading &&
            filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pickLibraryMidi(m)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded-xs text-left transition-shadow hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)] group"
                title={`Load "${rowLabel(m)}" into the piano roll`}
              >
                {m.favorite ? (
                  <Star aria-label="Favorite" className="w-3 h-3 shrink-0 text-[rgb(var(--et-accent))] fill-current" />
                ) : (
                  <Music aria-hidden="true" className="w-3 h-3 shrink-0 et-ink-3 group-hover:et-ink" />
                )}
                <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-zinc-300">{rowLabel(m)}</span>
                {typeof m.notes_count === 'number' && (
                  <span className="text-[12px] font-bold et-ink-3 shrink-0 tabular-nums">{m.notes_count}n</span>
                )}
              </button>
            ))}
        </div>
        <p className="px-1 text-[12px] font-semibold et-ink-3 leading-snug" data-import-parts-note="">
          A file or score of several tracks opens as one part each, on its own instrument. One track goes into the part you are editing.
          {onImportTracksFile ? ' As EDIT tracks puts each part on an EDIT track of its own at the start of the timeline.' : ''}
        </p>
      </DockFlyout>
    </>
  );
};
