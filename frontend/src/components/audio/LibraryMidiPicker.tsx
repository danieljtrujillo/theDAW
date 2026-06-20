import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, Music, X, FolderOpen } from 'lucide-react';
import { InstrumentPicker } from './InstrumentPicker';
import { fetchMidiBytesWithRetry } from '../../lib/fetchRetry';
import { logError } from '../../state/logStore';

export interface PickerAnchor { x: number; y: number }

interface MidiRow {
  id: string;
  source?: string;
  midi_path?: string;
  notes_count?: number;
  favorite?: number;
  parent_title?: string;
  parent_id?: string;
}

const rowLabel = (m: MidiRow): string => {
  const part =
    (m.midi_path || '').split(/[\\/]/).pop()?.replace(/\.midi?$/i, '') ||
    m.source ||
    'midi';
  const title = (m.parent_title || m.parent_id || 'Untitled').replace(/\.[a-z0-9]+$/i, '');
  return `${title} · ${part}`;
};

/**
 * Modal MIDI picker reused wherever MIDI can be dropped (editor timeline, Init
 * audio, …). Resolves the chosen MIDI to raw bytes + a label via `onPick`; the
 * caller decides what to do with them (a timeline clip, a rendered init blob).
 * The embedded InstrumentPicker sets the active voice, so the synthesized result
 * uses whatever instrument the user selects here.
 */
export const LibraryMidiPicker: React.FC<{
  open: boolean;
  title?: string;
  /** When set, the panel opens at this viewport point instead of screen-center. */
  anchor?: PickerAnchor | null;
  onClose: () => void;
  onPick: (bytes: ArrayBuffer, label: string) => void;
}> = ({ open, title = 'Add MIDI', anchor = null, onClose, onPick }) => {
  const [midis, setMidis] = useState<MidiRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PickerAnchor | null>(null);

  // Clamp the anchored panel inside the viewport once it has measured itself.
  useLayoutEffect(() => {
    if (!open || !anchor || !cardRef.current) {
      setPos(null);
      return;
    }
    const rect = cardRef.current.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(anchor.x, window.innerWidth - rect.width - pad));
    const y = Math.max(pad, Math.min(anchor.y, window.innerHeight - rect.height - pad));
    setPos({ x, y });
  }, [open, anchor]);

  const loadMidis = useCallback(async () => {
    setLoading(true);
    try {
      const j = await fetch('/api/library/_all/midi').then((r) => r.json());
      setMidis((j.midis as MidiRow[]) || []);
    } catch (e) {
      logError('midi-picker', `Could not load library MIDI: ${e instanceof Error ? e.message : String(e)}`);
      setMidis([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && midis === null && !loading) void loadMidis();
  }, [open, midis, loading, loadMidis]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const list = midis || [];
    const q = query.trim().toLowerCase();
    const matched = q ? list.filter((m) => rowLabel(m).toLowerCase().includes(q)) : list;
    return [...matched].sort((a, b) => {
      const fav = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
      return fav !== 0 ? fav : rowLabel(a).localeCompare(rowLabel(b));
    });
  }, [midis, query]);

  const pickLibrary = async (m: MidiRow) => {
    try {
      const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${m.id}`, { label: rowLabel(m) });
      onPick(buf, rowLabel(m));
      onClose();
    } catch (e) {
      logError('midi-picker', `Could not load MIDI: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const pickFile = async (file: File) => {
    try {
      onPick(await file.arrayBuffer(), file.name.replace(/\.midi?$/i, ''));
      onClose();
    } catch (e) {
      logError('midi-picker', `Could not read file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!open) return null;

  const anchored = !!anchor;

  return (
    <div
      className={`fixed inset-0 z-200 ${anchored ? '' : 'flex items-center justify-center bg-black/60 backdrop-blur-sm'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-label={title}
        aria-modal="true"
        className="w-96 max-w-[90vw] max-h-[80vh] bg-[#0a080f] border border-purple-500/30 rounded-lg shadow-[0_8px_40px_rgba(0,0,0,0.8)] flex flex-col"
        style={anchored ? { position: 'fixed', left: pos?.x ?? -9999, top: pos?.y ?? -9999 } : undefined}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="text-[11px] font-black uppercase tracking-widest text-purple-300">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3 py-2 flex flex-col gap-2 border-b border-white/5">
          <div className="flex items-center justify-between gap-2">
            <InstrumentPicker />
          </div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-white/3 hover:bg-white/8 border border-white/10 text-[10px] text-zinc-200 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5 text-purple-300 shrink-0" />
            From file on disk…
          </button>
          <input
            ref={fileRef}
            type="file"
            id="library-midi-picker-file"
            name="library-midi-picker-file"
            accept=".mid,.midi,audio/midi"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickFile(f);
              e.target.value = '';
            }}
          />
          <div className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded px-2">
            <Search className="w-3 h-3 text-zinc-500 shrink-0" />
            <input
              id="library-midi-picker-search"
              name="library-midi-picker-search"
              aria-label="Search library MIDI"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search library…"
              className="flex-1 min-w-0 bg-transparent border-none outline-none py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 p-2">
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
                onClick={() => void pickLibrary(m)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-purple-500/15 text-left transition-colors group"
                title={`Add "${rowLabel(m)}"`}
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
    </div>
  );
};
