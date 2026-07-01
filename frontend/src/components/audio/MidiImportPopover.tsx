import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FolderOpen, Search, Star, Music, FileMusic } from 'lucide-react';
import { sendMidiIdToTarget } from '../../lib/sendToTargets';
import { SHEET_ACCEPT } from '../../lib/sheetImportClient';
import { logError } from '../../state/logStore';

interface MidiRow {
  id: string;
  source?: string;
  midi_path?: string;
  notes_count?: number;
  favorite?: number;
  parent_title?: string;
  parent_id?: string;
}

/** "<title> · <part>" label for a library MIDI row, derived from its filename. */
const rowLabel = (m: MidiRow): string => {
  const part =
    (m.midi_path || '').split(/[\\/]/).pop()?.replace(/\.midi?$/i, '') ||
    m.source ||
    'midi';
  const title = (m.parent_title || m.parent_id || 'Untitled').replace(/\.[a-z0-9]+$/i, '');
  return `${title} · ${part}`;
};

/**
 * IMPORT MIDI control for the Piano Roll. One popover, two sources:
 *   - "From file…" opens the OS file picker (hidden <input type=file>).
 *   - the library list loads any converted MIDI straight into the roll.
 */
export const MidiImportPopover: React.FC<{
  onImportFile: (file: File) => void;
  /** Optional: import a notation file (MusicXML/ABC/kern) via the backend. */
  onImportSheetFile?: (file: File) => void;
}> = ({ onImportFile, onImportSheetFile }) => {
  const [open, setOpen] = useState(false);
  const [midis, setMidis] = useState<MidiRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLInputElement>(null);

  const loadMidis = useCallback(async () => {
    setLoading(true);
    try {
      const j = await fetch('/api/library/_all/midi').then((r) => r.json());
      setMidis((j.midis as MidiRow[]) || []);
    } catch (e) {
      logError('piano-roll', `Could not load library MIDI: ${e instanceof Error ? e.message : String(e)}`);
      setMidis([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch the library list the first time the popover opens.
  useEffect(() => {
    if (open && midis === null && !loading) void loadMidis();
  }, [open, midis, loading, loadMidis]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

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

  return (
    <div className="relative" ref={rootRef}>
      {/* Hidden OS file picker, triggered by "From file…". */}
      <input
        ref={fileRef}
        type="file"
        id="piano-roll-import-midi"
        name="piano-roll-import-midi"
        accept=".mid,.midi,audio/midi"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportFile(f);
          e.target.value = '';
          setOpen(false);
        }}
      />

      {/* Hidden picker for notation files (parsed on the backend via music21). */}
      {onImportSheetFile && (
        <input
          ref={sheetRef}
          type="file"
          id="piano-roll-import-sheet"
          name="piano-roll-import-sheet"
          accept={SHEET_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImportSheetFile(f);
            e.target.value = '';
            setOpen(false);
          }}
        />
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="piano-roll-import-popover"
        className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
        title="Import a MIDI file from disk or from the library"
      >
        <Upload className="w-3 h-3 text-purple-300" /> IMPORT MIDI
      </button>

      {open && (
        <div
          id="piano-roll-import-popover"
          role="menu"
          aria-label="Import MIDI"
          className="absolute right-0 top-full mt-1 z-50 w-72 bg-[#0a080f] border border-white/10 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.75)] p-2 flex flex-col gap-2"
        >
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-white/3 hover:bg-white/8 border border-white/10 text-[10px] text-zinc-200 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-purple-300 shrink-0" />
            MIDI file on disk…
          </button>

          {onImportSheetFile && (
            <button
              type="button"
              onClick={() => sheetRef.current?.click()}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-white/3 hover:bg-white/8 border border-white/10 text-[10px] text-zinc-200 transition-colors"
              title="Import a notation file: MusicXML, ABC, or Humdrum kern"
            >
              <FileMusic className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
              Sheet music (MusicXML / ABC)…
            </button>
          )}

          <div className="flex items-center gap-1.5 px-1 pt-0.5">
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">
              From library
            </span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          <div className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded px-2">
            <Search className="w-3 h-3 text-zinc-500 shrink-0" />
            <input
              id="piano-roll-library-midi-search"
              name="piano-roll-library-midi-search"
              aria-label="Search library MIDI"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="flex-1 min-w-0 bg-transparent border-none outline-none py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600"
            />
          </div>

          <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5 pr-0.5">
            {loading && (
              <span className="text-[9px] font-mono text-zinc-600 px-2 py-3 text-center">loading…</span>
            )}
            {!loading && filtered.length === 0 && (
              <span className="text-[9px] font-mono text-zinc-600 px-2 py-3 text-center">
                {midis && midis.length === 0 ? 'No library MIDI yet' : 'No matches'}
              </span>
            )}
            {!loading &&
              filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitem"
                  onClick={() => pickLibraryMidi(m)}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-purple-500/15 text-left transition-colors group"
                  title={`Load "${rowLabel(m)}" into the piano roll`}
                >
                  {m.favorite ? (
                    <Star className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />
                  ) : (
                    <Music className="w-3 h-3 text-zinc-600 group-hover:text-purple-300 shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 truncate text-[10px] text-zinc-300">{rowLabel(m)}</span>
                  {typeof m.notes_count === 'number' && (
                    <span className="text-[8px] font-mono text-zinc-600 shrink-0">{m.notes_count}n</span>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};
