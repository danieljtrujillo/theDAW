import React, { useEffect, useMemo, useRef, useState } from 'react';
import { List, useListRef, type RowComponentProps } from 'react-window';
import {
  Search, Database, Clock, Play, Pause, Download, Trash2,
  Music, Star, Tag, Filter, ArrowUpDown, Sparkles,
  LayoutGrid, List as ListIcon, Activity, Scissors, Layers, Wand2, PenLine,
  Package, Network, FileMusic, Loader2, Mic, Piano, ListOrdered,
  CheckSquare, Square, MoreHorizontal, Combine, Paintbrush, FileText, ChevronDown, Maximize2,
  Film, Image as ImageIcon, Upload, RefreshCw, Tv2, Repeat, Info, Link2, FolderPlus,
} from 'lucide-react';
import { CoverArt } from '../catalog/CoverArt';
import { importUrlToLibrary } from '../lib/onlineImport';
import { importFolder } from '../lib/mediaLibrary';
import { startQueue } from '../state/playlistQueue';
import { DESKTOP_DROP_ORIGIN, LIBRARY_IDS_MIME, MIDI_ID_MIME, STEM_ID_MIME, dropHasLibraryOrFiles, entriesFromDrop } from '../lib/libraryDrop';
import { midiRowPart, type LibraryMidiRow } from '../lib/libraryIndex';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { useConvertMenu } from '../convert/ConvertMenu';
import { LineageModal } from '../components/library/LineageModal';
import { SuggestPlaylistModal } from '../components/library/SuggestPlaylistModal';
import { StemsRunModal, type StemsRunOptions } from '../components/library/StemsRunModal';
import { AssetInspectorModal } from '../components/library/AssetInspectorModal';
import { TrackInfo } from '../components/library/TrackInfo';
import { ProviderBadge } from '../components/library/ProviderBadge';
import { MicRecorder } from '../components/audio/MicRecorder';
import { Section } from '../components/ui/Section';
import { useLibraryStore, LibraryIdCapError, type LibraryEntry } from '../state/libraryStore';
import {
  describeBulkConflict,
  LibraryBulkConflictError,
  fetchLibraryMatchCount,
  plainLibraryQuery,
} from '../lib/backendLocalProvider';
import { useLibraryCounts, type LibraryCountKey } from '../state/libraryCountsStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useEditorStore, computePeaks } from '../state/editorStore';
import { usePlayerStore } from '../state/playerStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { useFeatureToggleStore } from '../state/featureToggleStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { addBlobsToChimera } from '../lib/chimeraClient';
import { saveFile, extOfName } from '../lib/saveFile';
import { basenameOf } from '../lib/placesClient';
import { KnownFilesMenu } from '../components/ui/KnownFilesMenu';
import {
  listMedia, importMedia, deleteMedia, MEDIA_ACCEPT, backfillCoverArt, refreshCoverArt,
} from '../lib/mediaLibrary';
import { setAudioDragData } from '../lib/audioDnD';
import { renderMidiBufferToBlob } from '../lib/midiSynth';
import { fetchMidiBytesWithRetry, fetchBlobWithRetry } from '../lib/fetchRetry';
import { backendHttpBase } from '../lib/backendBase';
import { notationArtifactUrl, notationPackUrl } from '../lib/notationClient';
import { sendTrackToVj } from '../state/vjSetBus';
import {
  loadMidiIntoPianoRoll,
  midiIdToSendable,
  sendAudioToChimera,
  sendAudioToEditor,
  sendAudioToInit,
  sendAudioToInpaint,
  sendMidiIdToTarget,
  stemRowToSendable,
} from '../lib/sendToTargets';


const formatDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

// Every save in this view goes through saveFile: Save As opens in the folder
// last used for that kind of file, and the chosen path is remembered.

const EXT_BY_MIME: Record<string, string> = {
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/mpeg': '.mp3',
  'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
};

/** A title as a file name every desktop OS accepts. */
const fileSafe = (name: string, fallback = 'untitled'): string =>
  Array.from(name, (c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c)).join('').trim().replace(/[. ]+$/, '') || fallback;

/** `title` as a file name ending in `ext` (lowercase, with its dot). */
const withExt = (title: string, ext: string): string => {
  const safe = fileSafe(title);
  return !ext || safe.toLowerCase().endsWith(ext) ? safe : `${safe}${ext}`;
};

/** A song title slugged the way backend/modules/notation/router.py names score downloads. */
const songSlug = (title: string, fallback: string): string => {
  const cleaned = Array.from(title || '', (c) => (/[\p{L}\p{N} _-]/u.test(c) ? c : '_')).join('');
  const slug = cleaned.split(/\s+/).filter(Boolean).join('_').replace(/^[_-]+|[_-]+$/g, '');
  return Array.from(slug).slice(0, 60).join('') || fallback;
};

/** An entry's own file: its title plus the stored file's extension. */
const entryFileName = (entry: LibraryEntry): string =>
  withExt(entry.title || entry.id, extOfName(entry.audioFilename || '') || EXT_BY_MIME[entry.mimeType] || '');

const entryKind = (entry: LibraryEntry): string =>
  entry.kind === 'video' || entry.kind === 'image' ? entry.kind : 'audio';

const saveEntryFile = (entry: LibraryEntry, url: string) =>
  saveFile({ url, suggestedName: entryFileName(entry), kind: entryKind(entry) });

/** An entry bundle's name, as GET /api/library/{id}/bundle names it. */
const bundleFileName = (id: string, title: string): string =>
  `${Array.from(title || 'entry', (c) => (/[\p{L}\p{N}._-]/u.test(c) ? c : '_')).slice(0, 60).join('')}_${id.slice(0, 8)}.zip`;

type LibrarySubTab = 'tracks' | 'stems' | 'midi' | 'video' | 'score' | 'info';

/** How far `el` sits below the top of the scroll region `region`, in the
 *  region's own scroll pixels. The Shell scales the app with CSS zoom, so a
 *  client-rect distance is divided by the region's zoom first. */
const offsetInRegion = (el: HTMLElement, region: HTMLElement): { top: number; bottom: number } => {
  const r = region.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  const zoom = region.offsetHeight > 0 ? r.height / region.offsetHeight : 1;
  const z = zoom > 0 ? zoom : 1;
  return { top: (e.top - r.top) / z, bottom: (e.bottom - r.top) / z };
};

/* ═════════════════════ virtualized TRACKS list (react-window) ══════════════
 *
 * The library can hold 200,000 entries, so the list renders the rows on screen
 * and nothing else. Row indices are GLOBAL indices into the store's current
 * result set — the same space `entryAt` and the backend's `offset` use — and a
 * row whose page has not arrived yet draws a skeleton of the identical height,
 * so the scrollbar never jumps while pages load.
 */

/** List mode: card height (64) plus the 4px gap under it, in CSS px. */
const TRACK_ROW_HEIGHT = 68;
/** Grid mode: two square cards per line with `gap-2` between them. */
const GRID_COLUMNS = 2;
/** `gap-2`, in CSS px — used to turn a measured width into a row height. */
const GRID_GAP = 8;
/** Rows kept rendered beyond the viewport, per the ticket. */
const TRACK_OVERSCAN = 8;

/** Everything a track card needs that is the same for every row. */
interface TrackCardActions {
  viewMode: 'list' | 'grid';
  selectedIds: ReadonlySet<string>;
  selectedEntryId: string | null;
  engineEntryId: string | null;
  engineIsPlaying: boolean;
  onSelect: (entry: LibraryEntry, event: React.MouseEvent) => void;
  onInspect: (entry: LibraryEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: LibraryEntry) => void;
  onDragStart: (event: React.DragEvent<HTMLElement>, entry: LibraryEntry) => void;
  onPlay: (entry: LibraryEntry) => void;
  onToggleFavorite: (id: string) => void;
  onOpenDetails: (id: string) => void;
  onSendToNewTrack: (entry: LibraryEntry) => void;
  onSendToInit: (entry: LibraryEntry) => void;
  onSendToInpaint: (entry: LibraryEntry) => void;
  onSave: (entry: LibraryEntry) => void;
  onDelete: (entry: LibraryEntry) => void;
}

/** One library row. Single click selects; DOUBLE click opens the inspector. */
const TrackCard: React.FC<TrackCardActions & { entry: LibraryEntry }> = ({
  entry,
  viewMode,
  selectedIds,
  selectedEntryId,
  engineEntryId,
  engineIsPlaying,
  onSelect,
  onInspect,
  onContextMenu,
  onDragStart,
  onPlay,
  onToggleFavorite,
  onOpenDetails,
  onSendToNewTrack,
  onSendToInit,
  onSendToInpaint,
  onSave,
  onDelete,
}) => {
  const isCurrent = engineEntryId === entry.id && engineIsPlaying;
  return (
    <div
      data-library-entry-id={entry.id}
      data-follow-id={entry.id}
      draggable
      onDragStart={(e) => onDragStart(e, entry)}
      onClick={(e) => onSelect(entry, e)}
      onDoubleClick={() => onInspect(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={`hardware-card p-0! group cursor-grab active:cursor-grabbing transition-all hover:bg-white/4 overflow-hidden
        ${selectedIds.has(entry.id) || selectedEntryId === entry.id ? 'ring-1 ring-purple-500/60 bg-purple-500/6' : ''}
        ${viewMode === 'list' ? 'h-16 flex-row items-center p-1' : 'aspect-square flex-col'}`}
      title="Double-click for details. Drag onto a Waveform Editor track."
    >
      {viewMode === 'grid' && (
        <div className="flex-1 bg-black/40 relative">
          <CoverArt
            coverUrl={entry.coverUrl}
            title={entry.title}
            className="absolute inset-0 w-full h-full"
          />
          <button
            type="button"
            className="absolute top-1 right-1 p-1 bg-black/80 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            aria-label={isCurrent ? `Pause ${entry.title}` : `Play ${entry.title}`}
            onClick={(e) => { e.stopPropagation(); onPlay(entry); }}
          >
            {isCurrent ? <Pause className="w-3 h-3 text-purple-300" /> : <Play className="w-3 h-3 text-zinc-300" />}
          </button>
        </div>
      )}

      {viewMode === 'list' && (
        <CoverArt
          coverUrl={entry.coverUrl}
          title={entry.title}
          className="w-8 h-8 ml-0.5 shrink-0 rounded-sm"
          iconClassName="w-3.5 h-3.5"
        />
      )}

      <div className={`p-1.5 flex flex-col gap-0.5 min-w-0 ${viewMode === 'list' ? 'flex-1' : ''}`}>
        <div className="flex items-center justify-between overflow-hidden gap-2">
          <span className="font-bold text-[10px] truncate pr-2 text-zinc-200" title={entry.title}>
            {entry.title}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(entry.id); }}
            className="shrink-0"
            title={entry.favorite ? 'Unfavorite' : 'Favorite'}
            aria-label={entry.favorite ? `Unfavorite ${entry.title}` : `Favorite ${entry.title}`}
          >
            <Star className={`w-2.5 h-2.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
          </button>
        </div>
        {entry.prompt && (
          <span className="mono-label text-[8px]! text-zinc-500! truncate" title={entry.prompt}>
            {entry.prompt}
          </span>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 min-w-0">
            {/* The entry's one provider: what the file said about its origin
                when it said anything, derived from model/source otherwise. */}
            <ProviderBadge entry={entry} className="shrink-0" />
            <span className="text-[8px] font-mono text-purple-400/80 uppercase tracking-wider truncate">{entry.model}</span>
          </span>
          <div className="flex items-center gap-3 shrink-0">
            {(entry.playCount ?? 0) > 0 && (
              <span className="text-[8px] font-mono text-purple-300/70 flex items-center gap-0.5" title={`Played ${entry.playCount}x`}>
                <Play className="w-2 h-2 fill-current" />{entry.playCount}
              </span>
            )}
            <span className="text-[8px] font-mono text-zinc-600">{formatDuration(entry.duration)}</span>
            <span className="text-[8px] font-mono text-zinc-700">{formatDate(entry.timestamp)}</span>
            <span className="text-[8px] font-mono text-zinc-700">{formatSize(entry.fileSizeBytes)}</span>
            {viewMode === 'list' && (
              <div className="flex gap-1">
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onPlay(entry); }}
                  title={isCurrent ? 'Pause' : 'Play'}
                  aria-label={isCurrent ? `Pause ${entry.title}` : `Play ${entry.title}`}
                >
                  {isCurrent ? <Pause className="w-2.5 h-2.5 text-purple-400" /> : <Play className="w-2.5 h-2.5 text-zinc-400 group-hover:text-purple-400" />}
                </button>
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onOpenDetails(entry.id); }}
                  title="Open details (metadata, prompt, analysis)"
                  aria-label={`Open details for ${entry.title}`}
                >
                  <Info className="w-2.5 h-2.5 text-zinc-500 hover:text-emerald-300" />
                </button>
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onSendToNewTrack(entry); }}
                  title="Send to editor as a new track"
                  aria-label={`Send ${entry.title} to the editor as a new track`}
                >
                  <Layers className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                </button>
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onSendToInit(entry); }}
                  title="Send to Init audio"
                  aria-label={`Send ${entry.title} to Init audio`}
                >
                  <Wand2 className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                </button>
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onSendToInpaint(entry); }}
                  title="Send to Inpaint"
                  aria-label={`Send ${entry.title} to Inpaint`}
                >
                  <PenLine className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                </button>
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onSave(entry); }}
                  title="Save this file to a folder you choose."
                  aria-label={`Save ${entry.title}`}
                >
                  <Download className="w-2.5 h-2.5 text-zinc-600 hover:text-white" />
                </button>
                <button
                  type="button"
                  className="p-1 hover:bg-white/10 rounded"
                  onClick={(e) => { e.stopPropagation(); onDelete(entry); }}
                  title="Delete"
                  aria-label={`Delete ${entry.title}`}
                >
                  <Trash2 className="w-2.5 h-2.5 text-zinc-600 hover:text-red-400" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** A row whose page has not arrived. Same box, so nothing shifts when it does. */
const TrackSkeleton: React.FC<{ viewMode: 'list' | 'grid' }> = ({ viewMode }) => (
  <div
    aria-hidden="true"
    className={`hardware-card p-0! animate-pulse bg-white/3 ${viewMode === 'list' ? 'h-16 flex-row items-center p-1' : 'aspect-square flex-col'}`}
  >
    <div className={`bg-white/5 rounded-sm ${viewMode === 'list' ? 'w-8 h-8 ml-0.5 shrink-0' : 'flex-1'}`} />
    <div className="p-1.5 flex flex-col gap-1 flex-1 min-w-0">
      <div className="h-2 w-2/3 rounded bg-white/5" />
      <div className="h-1.5 w-1/3 rounded bg-white/5" />
    </div>
  </div>
);

/** `rowProps` for the virtualized track list. */
interface TrackRowData extends TrackCardActions {
  /** Cards per rendered row: 1 in list mode, `GRID_COLUMNS` in grid mode. */
  perRow: number;
  /** Rows matching the query, loaded or not. */
  total: number;
  /** The row at a global index, or undefined while its page is coming. */
  entryAt: (index: number) => LibraryEntry | undefined;
  /** New reference whenever a page lands, so rendered rows re-read `entryAt`. */
  loadedRows: readonly LibraryEntry[];
}

function TrackRow({ index, style, ariaAttributes, ...data }: RowComponentProps<TrackRowData>) {
  const { perRow, total, entryAt, viewMode } = data;
  const first = index * perRow;
  const cells: React.ReactNode[] = [];
  for (let column = 0; column < perRow; column += 1) {
    const at = first + column;
    if (at >= total) break;
    const entry = entryAt(at);
    cells.push(
      entry
        ? <TrackCard key={entry.id} entry={entry} {...data} />
        : <TrackSkeleton key={`skeleton-${at}`} viewMode={viewMode} />,
    );
  }
  return (
    <div
      style={style}
      {...ariaAttributes}
      className={viewMode === 'list' ? 'pb-1' : 'grid grid-cols-2 gap-2 pb-2'}
    >
      {cells}
    </div>
  );
}

/**
 * The whole-library numbers the two Clear actions act on. `nonFavorites` is
 * over the kind the list is showing (the filter those actions send); `all` is
 * every entry of every kind, which is what an empty filter deletes.
 */
interface MaintenanceCounts {
  nonFavorites: number;
  all: number;
}

/**
 * The confirmation for deleting the WHOLE library.
 *
 * Deleting 200,000 entries — favourites included, managed files off disk — is
 * not something an OK button should be able to do by accident, so the user
 * types the number back. A real modal rather than `window.prompt`: prompt is
 * unavailable in parts of the desktop shell, and this way the count, the
 * warning and the field are one labelled, focus-trapped dialog.
 */
const ClearAllDialog: React.FC<{
  total: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ total, busy, onCancel, onConfirm }) => {
  const uid = React.useId();
  const ids = { heading: `${uid}-heading`, hint: `${uid}-hint`, field: `${uid}-count` };
  const [typed, setTyped] = useState('');
  const fieldRef = React.useRef<HTMLInputElement | null>(null);
  const expected = String(total);
  const matches = typed.trim() === expected;

  React.useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.heading}
        aria-describedby={ids.hint}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-md flex flex-col gap-3 rounded border border-red-500/40 bg-[#0a080f] p-4 shadow-2xl"
      >
        <h2 id={ids.heading} className="text-[11px] font-black uppercase tracking-wider text-red-300">
          Delete the entire library
        </h2>
        <p id={ids.hint} className="text-[10px] leading-relaxed text-zinc-300">
          This removes all {total.toLocaleString()} entries — favourites included — and the audio
          files theDAW manages for them. Tracks you imported in place keep their original files.
          It cannot be undone.
        </p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) onConfirm();
          }}
        >
          <label htmlFor={ids.field} className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">
            Type {expected} to confirm
          </label>
          <input
            ref={fieldRef}
            id={ids.field}
            name={ids.field}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] font-mono text-zinc-100 focus:border-red-400/60 focus:outline-none"
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-white/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-zinc-300 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!matches || busy}
              className="rounded border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-red-200 hover:bg-red-500/25 disabled:opacity-30"
            >
              {busy ? 'Deleting…' : `Delete ${total.toLocaleString()}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export const LibraryView: React.FC<{ onSwitchTab?: (tab: string) => void; onExpand?: () => void }> = ({ onSwitchTab, onExpand }) => {
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [subTab, setSubTab] = useState<LibrarySubTab>('tracks');
  const [lineageOpen, setLineageOpen] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  // Selection is a SET of ids, not an array of rows: a select-all over 200,000
  // entries has to be cheap to hold and cheap to test membership in, and the
  // rows it names mostly are not loaded.
  const [selectedEntryIds, setSelectedEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  /** Shown under the toolbar when a select-all hits the server's id cap. */
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  /**
   * Whole-library counts for the two Clear actions, or null when the backend
   * has no bulk-delete route (the labels then say "loaded" and mean it).
   * Fetched when the OPTIONS menu opens, so a library nobody is maintaining
   * costs nothing.
   */
  const [maintenanceCounts, setMaintenanceCounts] = useState<MaintenanceCounts | null>(null);
  /** The whole-library total the typed "clear all" confirmation is asking for. */
  const [clearAllTotal, setClearAllTotal] = useState<number | null>(null);
  const [clearAllBusy, setClearAllBusy] = useState(false);
  /** The asset the inspector (T22) is open on; null when it is closed. */
  const [inspectEntryId, setInspectEntryId] = useState<string | null>(null);
  /** An entry revealed from elsewhere that is on no loaded page. */
  const [pinnedEntry, setPinnedEntry] = useState<LibraryEntry | null>(null);
  // Per-entry right-click menu now uses the shared ContextMenu
  // primitive (zoom-compensated, closes on outside-click / Esc / wheel
  // automatically). Payload carries the entryId of the right-clicked
  // row so the menu's items can read it without re-finding the row.
  const entryMenu = useContextMenu<{ entryId: string }>();
  // Second-stage "Convert to..." format picker (FFmpeg). Shared by the audio
  // context menu below; opened at the same spot the parent menu was.
  const convertMenu = useConvertMenu({
    onStart: (m) => logInfo('library', m),
    onError: (m) => logError('library', m),
  });
  const [allStems, setAllStems] = useState<Array<Record<string, unknown>> | null>(null);
  const [allMidis, setAllMidis] = useState<Array<Record<string, unknown>> | null>(null);
  // SCORE library tab: every notation/sheet artifact across all entries,
  // joined to its parent track's title. Fetched lazily when the SCORE tab
  // opens (notation is per-entry server-side, so this uses the aggregate
  // /_all/scores route, mirroring stems/midi).
  const [allScores, setAllScores] = useState<Array<Record<string, unknown>> | null>(null);
  // VJ video library: video + image entries live outside the audio store
  // (the default /entries list is audio-only). Fetched lazily when the
  // VIDEO tab opens and re-fetched after an import / delete.
  const [mediaEntries, setMediaEntries] = useState<LibraryEntry[] | null>(null);
  const [runningKind, setRunningKind] = useState<{ id: string; kind: 'analysis' | 'stems' | 'midi' } | null>(null);
  const [stemsBanner, setStemsBanner] = useState<{ phase: string; progress: number; message: string } | null>(null);
  const stemsAbortControllerRef = useRef<AbortController | null>(null);
  // Pre-run modal state for stem separation. The modal opens whenever
  // the user picks "Separate stems" from a context menu so they can pick
  // count / device / quality before kicking the heavy demucs run.
  const [stemsModal, setStemsModal] = useState<{ entryId: string; entryTitle: string } | null>(null);
  // Mic-in panel — toggled by a button at the top of the LIBRARY section.
  const [micOpen, setMicOpen] = useState(false);
  const midiFileInputRef = useRef<HTMLInputElement | null>(null);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);
  // Category counts for the sub-tab strip. They arrive with the library at
  // boot, so STEMS / MIDI / VIDEO / SCORE show a real number before their tab
  // has ever been opened; a tab that HAS loaded its own rows prefers those.
  const libraryCounts = useLibraryCounts((s) => s.counts);
  const countsStatus = useLibraryCounts((s) => s.status);
  const countsError = useLibraryCounts((s) => s.error);
  /** What a sub-tab prints between its parentheses: the tab's own rows once it
   *  has loaded them, else the boot-time summary, else '…' while the summary
   *  is still coming. If the summary failed and nothing was ever loaded the
   *  tabs print '—' and the strip grows one retry control — a button nested
   *  inside a tab button would be invalid DOM, so it lives beside them. */
  const tabCount = (own: number | null | undefined, key: LibraryCountKey): string => {
    if (own != null) return String(own);
    if (libraryCounts) return String(libraryCounts[key]);
    return countsStatus === 'error' ? '—' : '…';
  };


  const abortStems = async () => {
    if (!runningKind || runningKind.kind !== 'stems') return;
    logInfo('library', `Aborting stems for ${runningKind.id.slice(0, 8)}…`);
    try {
      await fetch(`/api/stems/${runningKind.id}/abort`, { method: 'POST' });
    } catch (e) {
      logError('library', `Abort request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Also tear down the client-side fetch so the UI returns quickly.
    if (stemsAbortControllerRef.current) {
      stemsAbortControllerRef.current.abort();
      stemsAbortControllerRef.current = null;
    }
  };

  const runJobForEntry = async (
    entryId: string,
    kind: 'analysis' | 'stems' | 'midi',
  ) => {
    setRunningKind({ id: entryId, kind });
    const labels: Record<typeof kind, string> = {
      analysis: 'analysis',
      stems: 'stem separation',
      midi: 'MIDI conversion',
    };
    logInfo('library', `Running ${labels[kind]} on ${entryId.slice(0, 8)}…`);

    // For stems, poll /progress every ~1.5s while the /run request is
    // in-flight so the user sees install/download/separate phases in
    // the ProcessingLog instead of an opaque 5-minute "running…".
    // Includes a 30-second heartbeat that logs elapsed time even when
    // the sidecar phase / message hasn't changed (demucs can sit at a
    // single percentage point for minutes while it processes shifts).
    let stemsPoller: ReturnType<typeof setInterval> | null = null;
    if (kind === 'stems') {
      let lastPhase = '';
      let lastMessage = '';
      let lastProgress = -1;
      let lastChangeAt = Date.now();
      let lastHeartbeatAt = Date.now();
      const runStartedAt = Date.now();
      stemsPoller = setInterval(() => {
        void fetch(`/api/stems/${entryId}/progress`)
          .then((r) => r.json())
          .then((p: { phase?: string; message?: string; progress?: number }) => {
            const phase = p.phase || 'idle';
            const message = p.message || '';
            const progress = typeof p.progress === 'number' ? p.progress : -1;
            // Banner state so the user can see + abort from anywhere
            // in the right panel.
            setStemsBanner({ phase, progress: progress >= 0 ? progress : 0, message });
            if (phase === 'idle') return;
            const now = Date.now();
            const elapsedTotal = Math.round((now - runStartedAt) / 1000);
            const fmtElapsed = (s: number) =>
              s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s` : `${s}s`;
            const pctText = progress >= 0 ? ` ${Math.round(progress)}%` : '';

            const changed =
              phase !== lastPhase || message !== lastMessage || progress !== lastProgress;
            if (changed) {
              lastPhase = phase;
              lastMessage = message;
              lastProgress = progress;
              lastChangeAt = now;
              lastHeartbeatAt = now;
              logInfo(
                'library',
                `stems[${entryId.slice(0, 8)}] ${phase}${pctText} @ ${fmtElapsed(elapsedTotal)}: ${message}`,
              );
              return;
            }

            // No change since last poll. Emit a heartbeat every 30s so
            // the user knows the run is still alive (demucs commonly
            // pauses ~minutes at a single percent during shifts).
            if (now - lastHeartbeatAt >= 30_000) {
              lastHeartbeatAt = now;
              const stuckFor = Math.round((now - lastChangeAt) / 1000);
              logInfo(
                'library',
                `stems[${entryId.slice(0, 8)}] still ${phase}${pctText} — no update for ${fmtElapsed(stuckFor)} (total ${fmtElapsed(elapsedTotal)})`,
              );
            }
          })
          .catch(() => {
            /* swallow — poll loop continues */
          });
      }, 1500);
    }

    // MIDI conversion and analysis report nothing until they return, and the
    // first MIDI run of a session spends a minute loading basic-pitch. A
    // 30-second heartbeat keeps the LOG showing the run is alive.
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    if (kind !== 'stems') {
      const startedAt = Date.now();
      heartbeat = setInterval(() => {
        const s = Math.round((Date.now() - startedAt) / 1000);
        const elapsed = `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
        logInfo('library', `${labels[kind]} still running on ${entryId.slice(0, 8)} (${elapsed})`);
      }, 30_000);
    }

    // Build the run URL — stems honours the user's device + count
    // preferences from Settings → Background features.
    let runUrl = `/api/${kind}/${entryId}/run`;
    if (kind === 'stems') {
      const stemsCfg = useFeatureToggleStore.getState().settings.stems;
      const params = new URLSearchParams({
        stems: String(stemsCfg.default_count || 4),
      });
      if (stemsCfg.device && stemsCfg.device !== 'auto') {
        params.set('device', stemsCfg.device);
      }
      if (stemsCfg.quality) {
        params.set('quality', stemsCfg.quality);
      }
      runUrl += `?${params.toString()}`;
    }

    // Wire an AbortController so the user-side Abort button can tear
    // the in-flight fetch down promptly (the backend abort endpoint
    // takes care of the actual demucs cancellation).
    const ctrl = new AbortController();
    if (kind === 'stems') stemsAbortControllerRef.current = ctrl;
    try {
      const res = await fetch(runUrl, { method: 'POST', signal: ctrl.signal });
      const payload = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const detail =
          (payload && (payload as Record<string, unknown>).detail) ??
          (payload as Record<string, unknown>).error ??
          `HTTP ${res.status}`;
        logError('library', `${labels[kind]} failed: ${detail}`);
        return;
      }

      // The MIDI runner returns a top-level status of failed | partial |
      // complete with per-target results. Stems / analysis use their own
      // shapes. Surface the real outcome rather than a flat "done".
      const status = String((payload as Record<string, unknown>).status ?? '');
      if (kind === 'midi') {
        const results = ((payload as { results?: Array<Record<string, unknown>> }).results) ?? [];
        const failed = results.filter((r) => !r.ok);
        if (status === 'failed') {
          const firstErr = failed[0]?.error ?? 'no engine installed (try: pip install basic-pitch)';
          logError('library', `MIDI conversion FAILED for ${entryId.slice(0, 8)}: ${firstErr}`);
        } else if (status === 'partial') {
          logError(
            'library',
            `MIDI conversion partial for ${entryId.slice(0, 8)}: ${failed.length}/${results.length} target(s) failed; first error: ${failed[0]?.error ?? '—'}`,
          );
        } else {
          logInfo('library', `MIDI conversion done for ${entryId.slice(0, 8)} (${results.length} targets)`);
        }
      } else if (kind === 'stems') {
        const written = (payload as Record<string, unknown>).written ?? 0;
        const stat = status || 'completed';
        logInfo('library', `stem separation ${stat} for ${entryId.slice(0, 8)}: ${written} stem(s) written`);
      } else {
        // analysis — surface bpm / key / pitch summary in the log so
        // the user can verify at a glance without opening Details.
        const a = payload as Record<string, unknown>;
        const bits: string[] = [];
        if (a.bpm != null) bits.push(`bpm=${Number(a.bpm).toFixed(1)}`);
        if (a.key) bits.push(`key=${a.key}${a.scale ? ' ' + a.scale : ''}`);
        if (a.pitch_mean_hz != null) bits.push(`pitch=${Number(a.pitch_mean_hz).toFixed(0)}Hz`);
        if (a.bars_estimated != null) bits.push(`bars=${Number(a.bars_estimated).toFixed(1)}`);
        if (a.rms_db != null) bits.push(`rms=${Number(a.rms_db).toFixed(1)}dB`);
        logInfo('library', `analysis done for ${entryId.slice(0, 8)}: ${bits.join(', ') || 'no useful data'}`);
      }
      // Invalidate sub-tab caches so the new stems/midi show up.
      if (kind === 'stems') setAllStems(null);
      if (kind === 'midi') setAllMidis(null);
      // …and the strip's counts, which a finished stems / MIDI job moved.
      if (kind === 'stems' || kind === 'midi') useLibraryCounts.getState().invalidate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === 'stems' && /aborted|AbortError/i.test(msg)) {
        logInfo('library', `stem separation cancelled for ${entryId.slice(0, 8)}`);
      } else {
        logError('library', `${labels[kind]} request failed: ${msg}`);
      }
    } finally {
      if (stemsPoller) clearInterval(stemsPoller);
      if (heartbeat) clearInterval(heartbeat);
      if (kind === 'stems') {
        stemsAbortControllerRef.current = null;
        setStemsBanner(null);
      }
      setRunningKind(null);
    }
  };

  // Fetch stems / midi indexes lazily when their sub-tab opens.
  useEffect(() => {
    // INFO lists the selected track's stems, MIDI and scores too.
    const info = subTab === 'info';
    if ((subTab === 'stems' || info) && allStems === null) {
      void fetch('/api/library/_all/stems')
        .then((r) => r.json())
        .then((j) => setAllStems(j.stems || []))
        .catch(() => setAllStems([]));
    }
    if ((subTab === 'midi' || info) && allMidis === null) {
      void fetch('/api/library/_all/midi')
        .then((r) => r.json())
        .then((j) => setAllMidis(j.midis || []))
        .catch(() => setAllMidis([]));
    }
    if (subTab === 'video' && mediaEntries === null) {
      void listMedia()
        .then((rows) => setMediaEntries(rows))
        .catch((e) => {
          logError('library', `Failed to load media library: ${e instanceof Error ? e.message : String(e)}`);
          setMediaEntries([]);
        });
    }
    if ((subTab === 'score' || info) && allScores === null) {
      void fetch('/api/library/_all/scores')
        .then((r) => r.json())
        .then((j) => setAllScores(j.scores || []))
        .catch(() => setAllScores([]));
    }
  }, [subTab, allStems, allMidis, mediaEntries, allScores]);

  const refreshMedia = React.useCallback(async () => {
    try {
      setMediaEntries(await listMedia());
    } catch (e) {
      logError('library', `Failed to refresh media library: ${e instanceof Error ? e.message : String(e)}`);
    }
    useLibraryCounts.getState().invalidate();
  }, []);

  // In-place refresh of the stems / midi indexes (no null-flicker, unlike the
  // lazy first-load). Passed to SubTabList so favorite / delete update the list
  // without resetting the sub-tab to its "Loading…" placeholder.
  const refreshStems = React.useCallback(async () => {
    try {
      const j = await fetch('/api/library/_all/stems').then((r) => r.json());
      setAllStems(j.stems || []);
    } catch (e) {
      logError('library', `Failed to refresh stems: ${e instanceof Error ? e.message : String(e)}`);
    }
    useLibraryCounts.getState().invalidate();
  }, []);

  const refreshMidi = React.useCallback(async () => {
    try {
      const j = await fetch('/api/library/_all/midi').then((r) => r.json());
      setAllMidis(j.midis || []);
    } catch (e) {
      logError('library', `Failed to refresh MIDI: ${e instanceof Error ? e.message : String(e)}`);
    }
    useLibraryCounts.getState().invalidate();
  }, []);

  // A score made or imported anywhere else (SCORE's IMPORT SCORE FILE and
  // BROWSE CORPUS, a MAKE) invalidates the library counts; when the score
  // count moves and this list has been loaded, fetch it again so the new
  // score is listed without a manual refresh. Fetched directly rather than
  // through refreshScores, which would invalidate the counts once more.
  const scoreCount = libraryCounts?.score ?? null;
  const scoresLoaded = allScores !== null;
  const seenScoreCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (scoreCount === null) return;
    const seen = seenScoreCountRef.current;
    seenScoreCountRef.current = scoreCount;
    if (seen === null || seen === scoreCount || !scoresLoaded) return;
    let cancelled = false;
    void fetch('/api/library/_all/scores')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setAllScores(j.scores || []);
      })
      .catch((e: unknown) => {
        logError('library', `Failed to refresh scores: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [scoreCount, scoresLoaded]);

  const refreshScores = React.useCallback(async () => {
    try {
      const j = await fetch('/api/library/_all/scores').then((r) => r.json());
      setAllScores(j.scores || []);
    } catch (e) {
      logError('library', `Failed to refresh scores: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The score tab's refresh IS the notation commit path from here: every
    // notation write the view knows about ends in one of these.
    useLibraryCounts.getState().invalidate();
  }, []);

  /** Parent-track titles for the Stems / MIDI / Score groups.
   *  The aggregate endpoints JOIN the title onto every row (`parent_title`),
   *  so this never walks the library — which at 200,000 entries it could not. */
  const parentTitles = useMemo(() => {
    const titles: Record<string, string> = {};
    for (const rows of [allStems, allMidis, allScores]) {
      for (const row of rows ?? []) {
        const pid = String(row.parent_id ?? '');
        const title = row.parent_title;
        if (pid && typeof title === 'string' && title) titles[pid] = title;
      }
    }
    return titles;
  }, [allStems, allMidis, allScores]);

  const stemsByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allStems || []).forEach((s) => {
      const pid = String(s.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(s);
    });
    return map;
  }, [allStems]);

  const midisByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allMidis || []).forEach((m) => {
      const pid = String(m.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(m);
    });
    return map;
  }, [allMidis]);

  const scoresByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allScores || []).forEach((s) => {
      const pid = String(s.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(s);
    });
    return map;
  }, [allScores]);

  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const onlyFavorites = useLibraryStore((s) => s.onlyFavorites);
  const sortBy = useLibraryStore((s) => s.sortBy);
  const playingId = useLibraryStore((s) => s.playingId);
  const load = useLibraryStore((s) => s.load);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const setOnlyFavorites = useLibraryStore((s) => s.setOnlyFavorites);
  const setSortBy = useLibraryStore((s) => s.setSortBy);
  const setPlayingId = useLibraryStore((s) => s.setPlayingId);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const removeEntry = useLibraryStore((s) => s.removeEntry);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  // Paging surface: `total` is every row matching the query (loaded or not),
  // `entries` is only the rows in hand, and `entryAt` resolves a global index.
  const total = useLibraryStore((s) => s.total);
  const pagesLoading = useLibraryStore((s) => s.pagesLoading);
  const pageError = useLibraryStore((s) => s.pageError);
  const entryAt = useLibraryStore((s) => s.entryAt);
  const ensureRange = useLibraryStore((s) => s.ensureRange);
  const getById = useLibraryStore((s) => s.getById);

  // Cover art. Both actions re-list afterwards: the entry record is what
  // carries the (version-stamped) cover URL, so the rail only repaints once
  // the store has the new one.
  const fetchCoverForEntry = React.useCallback(async (id: string) => {
    const title = useLibraryStore.getState().entries.find((e) => e.id === id)?.title ?? id;
    try {
      await refreshCoverArt(id);
      await refreshLibrary();
      logInfo('library', `Cover art attached to "${title}".`);
    } catch (e) {
      logError('library', `No cover art for "${title}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshLibrary]);

  const fetchMissingCovers = React.useCallback(async () => {
    try {
      const result = await backfillCoverArt();
      await refreshLibrary();
      logInfo(
        'library',
        `Cover art: ${result.written} attached, ${result.no_cover} without any, ${result.skipped} already had one.`,
      );
    } catch (e) {
      logError('library', `Cover backfill failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshLibrary]);

  // Gate the library fetch on backend readiness. The Shell mounts
  // immediately (so state stores initialize), but a /api/library/entries
  // call before uvicorn binds returns ECONNREFUSED and leaves the panel
  // stuck empty until the user hard-refreshes. We watch isBackendReady
  // and auto-fetch as soon as it flips true.
  //
  // The actual load() is wrapped in requestIdleCallback (with a
  // setTimeout fallback) so it doesn't pile on top of the vite HMR
  // commit / first paint — that's what produces the "message handler
  // took Xms" perf violations during initial connect.
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  useEffect(() => {
    if (!isBackendReady || loaded) return;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => void load(), { timeout: 1500 });
    } else {
      setTimeout(() => void load(), 0);
    }
  }, [isBackendReady, loaded, load]);

  // The selected rows we actually hold. At 200,000 entries a selection names
  // ids, not records: everything that needs a record works over the loaded
  // ones, and everything that only needs a count uses `selectedCount`.
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedEntryIds.has(entry.id)),
    [entries, selectedEntryIds],
  );
  const selectedCount = selectedEntryIds.size;
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineLoad = usePlayerStore((s) => s.load);
  const enginePlay = usePlayerStore((s) => s.play);
  const enginePause = usePlayerStore((s) => s.pause);

  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const showBottomTab = useBottomPanelStore((s) => s.showTab);
  const setDetailsPane = useBottomPanelStore((s) => s.setDetailsPane);

  // Audio files dropped anywhere on the list import to the library — the one
  // place imports land — and the newest is selected, the way the header IMPORT
  // button lands them. In-app library drags are not intercepted (a row dropped
  // on its own list is a no-op), so the gate takes no in-app mime.
  const [fileDragOver, setFileDragOver] = useState(false);
  const onListDragOver = (e: React.DragEvent) => {
    if (!dropHasLibraryOrFiles(e.dataTransfer, [])) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setFileDragOver(true);
  };
  const onListDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setFileDragOver(false);
  };
  const onListDrop = (e: React.DragEvent) => {
    setFileDragOver(false);
    const dt = e.dataTransfer;
    if (!dropHasLibraryOrFiles(dt, [])) return;
    e.preventDefault();
    void entriesFromDrop(dt, { mimes: [], entries: [], origin: DESKTOP_DROP_ORIGIN }).then((imported) => {
      const newest = imported[imported.length - 1];
      if (!newest) return;
      setSelectedEntry(newest.id);
      logInfo('library', `Imported ${imported.length} file(s) from the desktop into the library`);
    });
  };

  // Only an audio track has stems, MIDI or scores to look for. `getById`
  // answers from the loaded pages and, failing that, from a cached
  // single-entry fetch — so a selection made before its page was in hand
  // still resolves.
  const lookupVersion = useLibraryStore((s) => s.lookupVersion);
  const selectedEntry = useMemo(() => {
    if (!selectedEntryId) return null;
    const found = getById(selectedEntryId);
    return found && (found.kind ?? 'audio') === 'audio' ? found : null;
    // `lookupVersion` is the re-read trigger: it bumps when a by-id fetch lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryId, getById, entries, lookupVersion]);
  /** The selected track has nothing in a Stems / MIDI / Score list that has loaded. */
  const missingFor = (byParent: Record<string, unknown[]>, loadedRows: unknown[] | null): boolean =>
    !!selectedEntry && loadedRows !== null && !byParent[selectedEntry.id]?.length;

  const openScoreForEntry = (entryId: string) => {
    setSelectedEntry(entryId);
    showBottomTab('score');
  };

  // DETAILS tab with the details pane in view (the merged tab may be showing
  // only the media bucket).
  const openDetailsForEntry = (entryId: string) => {
    setSelectedEntry(entryId);
    if (useBottomPanelStore.getState().detailsPane === 'media') setDetailsPane('split');
    showBottomTab('details');
  };

  // Import from link: YouTube / SoundCloud / Bandcamp / direct audio URL
  // straight into the library (same path as the DJ source tree).
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const runLinkImport = async () => {
    const u = linkUrl.trim();
    if (!u || linkBusy) return;
    setLinkBusy(true);
    setLinkErr(null);
    try {
      const entry = await importUrlToLibrary(u);
      setLinkUrl('');
      setLinkOpen(false);
      openDetailsForEntry(entry.id);
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLinkBusy(false);
    }
  };

  /** The virtualized tracks list, and how many cards each of its rows holds. */
  const trackListRef = useListRef(null);
  const perRow = viewMode === 'grid' ? GRID_COLUMNS : 1;
  const perRowRef = useRef(perRow);
  useEffect(() => { perRowRef.current = perRow; }, [perRow]);

  // A query change invalidates the selection: the ids it names need not be in
  // the new result set at all, and at 200,000 entries there is no cheap way to
  // intersect the old selection with the new one.
  useEffect(() => {
    setSelectedEntryIds(new Set());
    setSelectionAnchorId(null);
    setSelectionNotice(null);
    setPinnedEntry(null);
  }, [searchQuery, onlyFavorites, sortBy]);

  /**
   * Scroll the list to a row, ignoring a row index the list does not have.
   * `scrollToRow` throws a RangeError for an out-of-range index, and the index
   * we resolved and the `total` the list was built from can disagree for a
   * frame while a query is settling — that is not worth an unhandled throw.
   */
  const scrollToRowSafely = React.useCallback((row: number, align: 'center' | 'smart') => {
    try {
      trackListRef.current?.scrollToRow({ index: row, align });
    } catch {
      /* the row is not in the list (yet) — leave the scroll position alone */
    }
  }, [trackListRef]);

  /** Bring a GLOBAL row index into view, loading the page it needs first. */
  const jumpToIndex = React.useCallback(async (index: number) => {
    await useLibraryStore.getState().ensureRange(index, index + 1);
    scrollToRowSafely(Math.floor(index / Math.max(1, perRowRef.current)), 'center');
  }, [scrollToRowSafely]);

  /**
   * Select an entry and scroll to it, wherever it is in the result set.
   *
   * The position comes from the server's id list, because the row is usually
   * on a page nobody has loaded. When the server refuses to enumerate that
   * many ids, the entry itself is pinned above the list instead, with a way
   * to try the jump again once the search has been narrowed.
   */
  const revealEntry = React.useCallback(async (id: string) => {
    setSubTab('tracks');
    setSelectedEntryIds(new Set([id]));
    setSelectionAnchorId(id);
    setSelectedEntry(id);
    setPinnedEntry(null);
    try {
      const ids = await useLibraryStore.getState().listFilteredIds();
      const at = ids.indexOf(id);
      if (at >= 0) {
        setSelectionNotice(null);
        await jumpToIndex(at);
        return;
      }
    } catch (e) {
      setSelectionNotice(
        e instanceof LibraryIdCapError
          ? e.message
          : `Could not locate the track: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const entry = await useLibraryStore.getState().ensureEntry(id);
    if (entry) setPinnedEntry(entry);
  }, [jumpToIndex, setSelectedEntry]);

  // Shared ContextMenu handles outside-click / Esc / wheel close, so
  // the old per-mount global listener block is gone.

  // Listen for the graph-node right-click actions that fire window
  // events the rest of the app picks up (see LineageModal.tsx graph
  // node ContextMenu). Open-lineage opens our embedded LineageModal
  // at the requested entry; reveal-library-entry selects + scrolls.
  useEffect(() => {
    const onOpenLineage = (e: Event) => {
      const id = (e as CustomEvent).detail?.entryId;
      if (typeof id === 'string') setLineageOpen(id);
    };
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent).detail?.entryId;
      if (typeof id !== 'string') return;
      showBottomTab('details');
      // The row is almost certainly on a page nobody has loaded, so this
      // resolves its index first and scrolls the virtual list there.
      void revealEntry(id);
    };
    window.addEventListener('thedaw:open-lineage', onOpenLineage);
    window.addEventListener('thedaw:reveal-library-entry', onReveal);
    return () => {
      window.removeEventListener('thedaw:open-lineage', onOpenLineage);
      window.removeEventListener('thedaw:reveal-library-entry', onReveal);
    };
  }, [revealEntry, showBottomTab]);

  const handleSelectEntry = React.useCallback((entry: LibraryEntry, event?: React.MouseEvent) => {
    const additive = !!(event?.ctrlKey || event?.metaKey);
    const range = !!event?.shiftKey;

    if (range && selectionAnchorId) {
      // A shift-range routinely spans pages nobody has loaded, so the ORDER
      // comes from the server's id list, never from the rows on screen.
      void (async () => {
        try {
          const ids = await useLibraryStore.getState().listFilteredIds();
          const anchorIndex = ids.indexOf(selectionAnchorId);
          const targetIndex = ids.indexOf(entry.id);
          if (anchorIndex < 0 || targetIndex < 0) {
            setSelectedEntryIds(new Set([entry.id]));
            return;
          }
          const [from, to] = anchorIndex < targetIndex
            ? [anchorIndex, targetIndex]
            : [targetIndex, anchorIndex];
          const rangeIds = ids.slice(from, to + 1);
          setSelectedEntryIds((prev) => (
            additive ? new Set([...prev, ...rangeIds]) : new Set(rangeIds)
          ));
          setSelectionNotice(null);
        } catch (e) {
          setSelectionNotice(
            e instanceof LibraryIdCapError
              ? e.message
              : `Could not select the range: ${e instanceof Error ? e.message : String(e)}`,
          );
          setSelectedEntryIds(new Set([entry.id]));
        }
      })();
    } else if (additive) {
      setSelectedEntryIds((prev) => {
        const next = new Set(prev);
        if (next.has(entry.id)) next.delete(entry.id);
        else next.add(entry.id);
        return next;
      });
      setSelectionAnchorId(entry.id);
    } else {
      setSelectedEntryIds(new Set([entry.id]));
      setSelectionAnchorId(entry.id);
    }

    setSelectedEntry(entry.id);
    // Selecting a track no longer auto-opens the Details tab (per user).
    // Details is still reachable via the bottom-panel tab + open-lineage events.
  }, [selectionAnchorId, setSelectedEntry]);

  // Select one track by id, as a plain click on its row does: from a group
  // title in Stems / MIDI / Score, or a relative in INFO.
  const selectEntryById = (id: string) => {
    setSelectedEntryIds(new Set([id]));
    setSelectionAnchorId(id);
    setSelectedEntry(id);
  };

  // The library stays on the last clicked track: every tab opens at that
  // track (its row in Tracks, its group in Stems / MIDI / Score), and a
  // selection made while a tab is open brings the track into view there.
  const listRef = useRef<HTMLDivElement | null>(null);
  const followedTabRef = useRef<LibrarySubTab | null>(null);
  const tabLoaded =
    subTab === 'stems' ? allStems !== null
      : subTab === 'midi' ? allMidis !== null
        : subTab === 'score' ? allScores !== null
          : true;
  useEffect(() => {
    const region = listRef.current;
    // TRACKS scrolls inside the virtualized List, which owns its own scroll
    // position (restored below); the DOM walk below only applies to the tabs
    // that still render every row.
    if (!region || !tabLoaded || subTab === 'tracks') return;
    const raf = window.requestAnimationFrame(() => {
      const tabChanged = followedTabRef.current !== subTab;
      followedTabRef.current = subTab;
      const el = selectedEntryId
        ? region.querySelector<HTMLElement>(`[data-follow-id="${CSS.escape(selectedEntryId)}"]`)
        : null;
      // A new tab opens at its top, and moves only when the track is not
      // already in view there, so the tab's own toolbar stays in sight.
      if (tabChanged) region.scrollTop = 0;
      if (!el) return;
      const { top, bottom } = offsetInRegion(el, region);
      const margin = 4;
      if (top < 0 || bottom - top > region.clientHeight) {
        region.scrollTop += top - margin;
      } else if (bottom > region.clientHeight) {
        region.scrollTop += tabChanged ? top - margin : bottom - region.clientHeight + margin;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [subTab, selectedEntryId, tabLoaded]);

  // Scroll restoration for the virtualized TRACKS list: leaving the tab
  // records where the user was, and coming back puts them there again.
  const trackScrollTopRef = useRef(0);
  useEffect(() => {
    if (subTab !== 'tracks') return;
    const api = trackListRef.current;
    const element = api?.element ?? null;
    if (element && trackScrollTopRef.current > 0) {
      element.scrollTop = trackScrollTopRef.current;
    }
    return () => {
      const el = trackListRef.current?.element;
      if (el) trackScrollTopRef.current = el.scrollTop;
    };
  }, [subTab, trackListRef]);

  const handleEntryContextMenu = React.useCallback((event: React.MouseEvent, entry: LibraryEntry) => {
    event.stopPropagation();
    setSelectedEntryIds((prev) => (prev.has(entry.id) ? prev : new Set([entry.id])));
    if (!selectedEntryIds.has(entry.id)) {
      setSelectionAnchorId(entry.id);
      setSelectedEntry(entry.id);
    }
    entryMenu.open(event, { entryId: entry.id });
  }, [entryMenu, selectedEntryIds, setSelectedEntry]);

  const sendEntryToTrack = async (
    entry: LibraryEntry,
    target: 'first-track-tail' | 'new-track',
  ) => {
    const editor = useEditorStore.getState();
    let trackId: string;
    if (target === 'new-track' || editor.tracks.length === 0) {
      trackId = editor.addTrack({ name: entry.title });
    } else {
      trackId = editor.tracks[0].id;
    }
    const tail =
      target === 'new-track'
        ? 0
        : Math.max(
            0,
            ...editor.clips
              .filter((c) => c.trackId === trackId)
              .map((c) => c.startSec + c.durationSec),
          );
    try {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      const { peaks, duration } = await computePeaks(blob, 240);
      // Re-read tracks after potential addTrack so we pick up the right color.
      const trackColor =
        useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
      const clipId = editor.addClipToTrack({
        trackId,
        label: entry.title,
        audioBlob: blob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec: tail,
        color: trackColor,
        libraryEntryId: entry.id,
      });
      editor.cachePeaks(clipId, peaks);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('library', `Could not send to editor: ${msg}`);
    }
  };

  // One "send to editor" action — always appends as a new track at the
  // end of the timeline (the user collapsed the old append-to-track-1 +
  // new-track pair into a single button).
  const handleSendToNewTrack = (entry: LibraryEntry) => void sendEntryToTrack(entry, 'new-track');

  const patchGenParams = useGenerateParamsStore((s) => s.patch);

  const handleSendToInit = async (entry: LibraryEntry) => {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    const file = new File([blob], entry.title, { type: entry.mimeType });
    patchGenParams({
      initAudioFile: file,
      initAudioEnabled: true,
      initAudioSourceLabel: null,
      initAudioSourceClipLabels: [],
    });
  };

  const handleSendSelectedToInit = () => {
    const targets = selectedEntries.length > 0
      ? selectedEntries
      : (() => {
          const ctxId = entryMenu.payload?.entryId;
          const ctxEntry = ctxId ? getById(ctxId) : undefined;
          return ctxEntry ? [ctxEntry] : [];
        })();
    if (targets.length === 0) return;

    void (async () => {
      const fetchBlob = useLibraryStore.getState().fetchAudioBlob;
      if (targets.length === 1) {
        await handleSendToInit(targets[0]);
      } else {
        const items = await Promise.all(
          targets.map(async (entry) => ({
            blob: await fetchBlob(entry),
            mimeType: entry.mimeType,
            label: entry.title,
          })),
        );
        addBlobsToChimera(items);
      }
      onSwitchTab?.('create');
      entryMenu.close();
    })();
  };

  const handleSendToInpaint = async (entry: LibraryEntry) => {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    const file = new File([blob], entry.title, { type: entry.mimeType });
    patchGenParams({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
  };

  // Handler invoked from StemsRunModal — applies the user's per-run
  // choices (writing them back as defaults if they ticked the checkbox)
  // and kicks the actual /api/stems/<id>/run with those query params.
  const onConfirmStemsModal = async (opts: StemsRunOptions) => {
    const modal = stemsModal;
    if (!modal) return;
    setStemsModal(null);
    if (opts.persistAsDefault) {
      // Fire-and-forget — backend persists to data/settings.json and the
      // feature store reconciles on next refresh. Don't block the run.
      void patchFeatures({
        stems: {
          default_count: opts.stems,
          device: opts.device,
          quality: opts.quality,
        },
      });
    } else {
      // Even when not persisting, set the in-memory store so the
      // existing runJobForEntry() (which reads from the store) picks up
      // the user's per-run choice without a backend round-trip.
      useFeatureToggleStore.setState((s) => ({
        settings: {
          ...s.settings,
          stems: {
            ...s.settings.stems,
            default_count: opts.stems,
            device: opts.device,
            quality: opts.quality,
          },
        },
      }));
    }
    await runJobForEntry(modal.entryId, 'stems');
  };

  // Picks a .mid file off disk and loads it straight into the piano roll
  // — gives the user a "MIDI IN" path that doesn't require running the
  // basic-pitch engine first. Reusable for any /mid file on disk.
  const onLoadMidiFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      loadMidiIntoPianoRoll(buf, 'piano-roll', file.name);
    } catch (e) {
      logError('library', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Fed by the file input and the Recent list alike; each file loads in turn.
  const onLoadMidiFiles = (files: File[]) => {
    for (const file of files) void onLoadMidiFile(file);
  };

  /**
   * The whole-library counts the Clear actions name, straight from the server:
   * one row fetched three times for its `total`, never a page of rows.
   *
   * Non-favourites are counted as (this kind) − (this kind, favourited) rather
   * than by asking for `favorite=false`, because the list endpoint's `favorite`
   * parameter only ever means "favourites only" — a false there would quietly
   * count the whole library and the number under the Delete button has to be
   * the number that gets deleted.
   *
   * Null against a backend with no paged list (it has every row in hand, so the
   * loaded-row wording is the true wording there).
   */
  const refreshMaintenanceCounts = React.useCallback(async (): Promise<MaintenanceCounts | null> => {
    const store = useLibraryStore.getState();
    if (!store.paged || !store.bulkDeleteSupported) return null;
    // `provider` is cleared alongside q/favorite/source: these counts are what
    // the bulk-delete filter below actually targets, and that filter carries no
    // provider. Leaving it in would print a count the server then refuses.
    // One helper does that clearing for every counting call site in the app.
    const kindOnly = plainLibraryQuery(store.getQuery());
    try {
      const [everyKind, thisKind, favourites] = await Promise.all([
        fetchLibraryMatchCount({ ...kindOnly, kind: 'all' }),
        fetchLibraryMatchCount(kindOnly),
        fetchLibraryMatchCount({ ...kindOnly, favorite: true }),
      ]);
      if (everyKind == null || thisKind == null || favourites == null) return null;
      const next: MaintenanceCounts = {
        nonFavorites: Math.max(0, thisKind - favourites),
        all: everyKind,
      };
      setMaintenanceCounts(next);
      return next;
    } catch (e) {
      logWarn('library', `Could not count the library: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, []);

  const handlePlay = async (entry: LibraryEntry) => {
    // If this entry is already loaded in the global engine, just toggle play/pause.
    if (engineEntryId === entry.id) {
      if (engineIsPlaying) {
        enginePause();
        setPlayingId(null);
      } else {
        enginePlay();
        setPlayingId(entry.id);
      }
      return;
    }
    // Play the list, not the track: pressing play on a row queues EVERY row
    // the current filters match — the server's id list, not the few hundred
    // rows in hand — starting at that row. The transport's repeat mode decides
    // what happens at the end: stop, wrap, or loop this one track. The queue
    // re-resolves each id as it reaches it, so a track whose page was evicted
    // an hour into the set still plays.
    try {
      const ids = await useLibraryStore.getState().listFilteredIds();
      const at = ids.indexOf(entry.id);
      if (at >= 0) {
        setSelectionNotice(null);
        await startQueue(ids, at);
        return;
      }
    } catch (e) {
      // Over the server's id cap (or the route failed): say so, then play the
      // one track the user actually clicked rather than nothing at all.
      setSelectionNotice(
        e instanceof LibraryIdCapError
          ? `${e.message} Playing this track on its own.`
          : `Could not queue the list: ${e instanceof Error ? e.message : String(e)}. Playing this track on its own.`,
      );
    }
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    await engineLoad(blob, { label: entry.title, entryId: entry.id });
    enginePlay();
    setPlayingId(entry.id);
  };

  const handleImportFolder = async () => {
    try {
      const res = await importFolder();
      if (res.cancelled) return;
      await useLibraryStore.getState().refresh();
      logInfo(
        'library',
        `Added ${res.entries.length} track${res.entries.length === 1 ? '' : 's'} from ${res.folder}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('library', `Folder import failed: ${msg}`);
      useStatusBarStore.getState().setText(`FOLDER IMPORT FAILED: ${msg}`);
    }
  };

  // Compact analytics strip at the very top of the panel — the user
  // wanted the prior "LIBRARY ANALYSIS" section's stats hoisted up
  // here as small chip-style features instead of taking up real
  // estate at the bottom of the panel.
  // Sums are over the rows in hand, not the whole library: at 200,000 entries
  // the browser never holds them all, and the backend does not total them.
  // The entry COUNT is the server's `total`, which is the real one.
  const loadedStats = useMemo(() => {
    let bytes = 0;
    let seconds = 0;
    let favorites = 0;
    for (const e of entries) {
      bytes += e.fileSizeBytes;
      seconds += e.duration;
      if (e.favorite) favorites += 1;
    }
    return { bytes, seconds, favorites };
  }, [entries]);
  /** "200,134 tracks", with the query echoed when one is active. */
  const totalLabel = `${total.toLocaleString()} ${total === 1 ? 'track' : 'tracks'}`;

  /* ── the virtualized tracks list ──────────────────────────────────────── */

  // Measured from the List itself: grid rows are as tall as a card is wide
  // (the cards are aspect-square), and a page-down step is a viewport of rows.
  const [listSize, setListSize] = useState({ width: 0, height: 0 });
  const handleListResize = React.useCallback(
    (size: { width: number; height: number }) => setListSize(size),
    [],
  );
  const trackRowHeight = viewMode === 'grid'
    ? Math.max(96, Math.round((listSize.width - GRID_GAP) / GRID_COLUMNS) + GRID_GAP)
    : TRACK_ROW_HEIGHT;

  /** The rows react-window has rendered, INCLUDING overscan, drive the fetch. */
  const handleRowsRendered = React.useCallback((
    _visible: { startIndex: number; stopIndex: number },
    rendered: { startIndex: number; stopIndex: number },
  ) => {
    const step = Math.max(1, perRowRef.current);
    void ensureRange(rendered.startIndex * step, (rendered.stopIndex + 1) * step - 1);
  }, [ensureRange]);

  const handleRowDragStart = React.useCallback((e: React.DragEvent<HTMLElement>, entry: LibraryEntry) => {
    e.dataTransfer.setData('application/x-thedaw-library-id', entry.id);
    e.dataTransfer.setData('text/plain', entry.title);
    e.dataTransfer.effectAllowed = 'copyMove';
    // A drag of a multi-selection carries the rows we HOLD; ids on pages that
    // were never loaded have no blob to fetch and no label to show.
    const lib = useLibraryStore.getState();
    const selected = selectedEntryIds.has(entry.id)
      ? lib.entries.filter((en) => selectedEntryIds.has(en.id))
      : [];
    const dragItems = selected.length > 1 ? selected : [entry];
    // A >1 selection carries every selected id — the dragged row first, the
    // rest in selection order — so the editor places each on its own track.
    // The single id above still serves legacy single-id targets; single drags
    // write nothing new.
    if (dragItems.length > 1) {
      const ids = [entry.id, ...dragItems.filter((en) => en.id !== entry.id).map((en) => en.id)];
      e.dataTransfer.setData(LIBRARY_IDS_MIME, JSON.stringify(ids));
    }
    setAudioDragData(e, dragItems.map((en) => ({
      fetcher: () => lib.fetchAudioBlob(en),
      mimeType: en.mimeType,
      label: en.title,
      entryId: en.id,
    })));
  }, [selectedEntryIds]);

  const handleDeleteRow = React.useCallback((entry: LibraryEntry) => {
    if (confirm(`Delete "${entry.title}"?`)) void removeEntry(entry.id);
  }, [removeEntry]);

  const handleSaveRow = React.useCallback((entry: LibraryEntry) => {
    void saveEntryFile(entry, getAudioUrl(entry));
  }, [getAudioUrl]);

  const handleToggleFavorite = React.useCallback((id: string) => {
    void toggleFavorite(id);
  }, [toggleFavorite]);

  const handlePlayRow = React.useCallback((entry: LibraryEntry) => {
    void handlePlay(entry);
    // `handlePlay` is re-created each render; it reads live state, so a stale
    // identity here would still do the right thing — but keep it honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handlePlay]);

  /** Keyboard navigation over the virtual list: the row a key lands on is
   *  loaded, scrolled to, and selected, exactly as a click would. */
  const [focusIndex, setFocusIndex] = useState(0);
  const onTracksKeyDown = React.useCallback((event: React.KeyboardEvent) => {
    if (total === 0) return;
    const step = Math.max(1, perRowRef.current);
    const rowsPerViewport = Math.max(1, Math.floor(listSize.height / Math.max(1, trackRowHeight)));
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = focusIndex + step; break;
      case 'ArrowUp': next = focusIndex - step; break;
      case 'ArrowRight': next = focusIndex + 1; break;
      case 'ArrowLeft': next = focusIndex - 1; break;
      case 'PageDown': next = focusIndex + rowsPerViewport * step; break;
      case 'PageUp': next = focusIndex - rowsPerViewport * step; break;
      case 'Home': next = 0; break;
      case 'End': next = total - 1; break;
      default: return;
    }
    event.preventDefault();
    const at = Math.max(0, Math.min(total - 1, next));
    setFocusIndex(at);
    void (async () => {
      await ensureRange(at, at);
      scrollToRowSafely(Math.floor(at / step), 'smart');
      const entry = useLibraryStore.getState().entryAt(at);
      if (!entry) return;
      setSelectedEntryIds(new Set([entry.id]));
      setSelectionAnchorId(entry.id);
      setSelectedEntry(entry.id);
    })();
  }, [ensureRange, focusIndex, listSize.height, scrollToRowSafely, setSelectedEntry, total, trackRowHeight]);

  const trackRowProps = useMemo(() => ({
    perRow,
    total,
    entryAt,
    // A new reference every time a page lands, which is what makes the
    // rendered rows re-read `entryAt` and swap their skeletons for real rows.
    loadedRows: entries,
    viewMode,
    selectedIds: selectedEntryIds,
    selectedEntryId,
    engineEntryId,
    engineIsPlaying,
    onSelect: handleSelectEntry,
    onInspect: (entry: LibraryEntry) => setInspectEntryId(entry.id),
    onContextMenu: handleEntryContextMenu,
    onDragStart: handleRowDragStart,
    onPlay: handlePlayRow,
    onToggleFavorite: handleToggleFavorite,
    onOpenDetails: openDetailsForEntry,
    onSendToNewTrack: handleSendToNewTrack,
    onSendToInit: (entry: LibraryEntry) => { void handleSendToInit(entry); },
    onSendToInpaint: (entry: LibraryEntry) => { void handleSendToInpaint(entry); },
    onSave: handleSaveRow,
    onDelete: handleDeleteRow,
    // `openDetailsForEntry`, `handleSendTo*` are re-created each render and
    // read live state; re-running this memo on every render is cheap next to
    // the ~20 rows it feeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    perRow, total, entryAt, entries, viewMode, selectedEntryIds, selectedEntryId,
    engineEntryId, engineIsPlaying, handleSelectEntry, handleEntryContextMenu,
    handleRowDragStart, handlePlayRow, handleToggleFavorite, handleSaveRow, handleDeleteRow,
  ]);

  return (
    // The panel itself does NOT scroll (overflow-hidden); the upper region
    // (stats + LIBRARY header + search + filters + sub-tabs) stays pinned and
    // ONLY the per-tab list region scrolls (see the scroll wrapper below).
    // h-full + min-h-0 let the flex parent collapse so the fill chain works
    // inside the right rail without clipping the always-on Log section.
    <div className="flex flex-col gap-2 h-full min-h-0 overflow-hidden text-[11px] pb-2 px-2 pt-2">

      {/* Top stats strip — compact "features" version of the old
          LIBRARY ANALYSIS section. */}
      <div className="shrink-0 flex items-center gap-1 flex-wrap text-[8px] font-mono uppercase tracking-widest text-zinc-500 pb-1 border-b border-white/5">
        <span
          className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10"
          title={searchQuery.trim() ? `Matching “${searchQuery.trim()}”` : 'Every entry in the library'}
        >
          <span className="text-zinc-300">{total.toLocaleString()}</span> entries
        </span>
        <span
          className="px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20"
          title="Favorites among the rows loaded so far"
        >
          <Star className="w-2 h-2 fill-current inline-block text-yellow-400 -mt-0.5" />{' '}
          <span className="text-yellow-200">{loadedStats.favorites}</span>
        </span>
        <span
          className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10"
          title={`Size of the ${loadedStats.bytes > 0 ? entries.length : 0} rows loaded so far`}
        >
          <span className="text-zinc-300">{formatSize(loadedStats.bytes)}</span>
        </span>
        <span
          className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10"
          title="Total length of the rows loaded so far"
        >
          <span className="text-zinc-300">{formatDuration(loadedStats.seconds)}</span>
        </span>
      </div>

      {/* Stems running banner. Shows live phase + progress + an Abort
          button so the user can bail without right-click-finding the
          original entry. */}
      {runningKind?.kind === 'stems' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-purple-500/40 bg-purple-500/15 text-[10px] font-mono">
          <Loader2 className="w-3 h-3 text-purple-300 animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-purple-200 truncate">
              Stems · {runningKind.id.slice(0, 8)} · {stemsBanner?.phase ?? '…'}
              {typeof stemsBanner?.progress === 'number' && stemsBanner.progress > 0
                ? ` · ${Math.round(stemsBanner.progress)}%`
                : ''}
            </div>
            {stemsBanner?.message && (
              <div className="text-[8px] text-zinc-400 truncate">{stemsBanner.message}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void abortStems()}
            className="shrink-0 text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15"
            title="Abort the running stem separation"
          >
            Abort
          </button>
        </div>
      )}

      {/* Stems pre-run modal — picks count / device / quality, optionally
          saves them as the new defaults, then kicks runJobForEntry. */}
      <StemsRunModal
        open={stemsModal !== null}
        entryLabel={stemsModal?.entryTitle}
        onCancel={() => setStemsModal(null)}
        onConfirm={(opts) => void onConfirmStemsModal(opts)}
      />

      {/* Everything the app knows about one asset. Opened by double-clicking a
          row, and keyed by that asset's stable id — sorting, filtering or a
          page landing under it cannot make it show a different asset. */}
      <AssetInspectorModal
        entryId={inspectEntryId}
        onClose={() => setInspectEntryId(null)}
      />

      {/* Hidden file picker — used by the "Import MIDI" toolbar button.
          Drives loadMidiIntoPianoRoll() so users can pull a .mid off
          disk straight into the piano roll without running basic-pitch.
          `multiple` lets the user batch-import several .mid files in
          one go; each is loaded sequentially. */}
      <label htmlFor="library-import-midi" className="sr-only">MIDI files to load into the piano roll</label>
      <input
        ref={midiFileInputRef}
        type="file"
        id="library-import-midi"
        name="library-import-midi"
        accept=".mid,.midi,audio/midi"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so picking the same file(s) twice re-fires onChange.
          e.target.value = '';
          onLoadMidiFiles(files);
        }}
      />

      <Section title="LIBRARY" icon={Database} defaultOpen={true} resizable={false} collapsible={false} fill maxContentHeight={null} rightNode={
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="text-[8px] font-mono text-zinc-600" title={`${totalLabel} match the current filters`}>
            {totalLabel.toUpperCase()}
            {searchQuery.trim() ? ` · SHOWING RESULTS FOR “${searchQuery.trim()}”` : ''}
          </span>
          {/* Mic-in toggle removed per spec — the MicRecorder lives
              on EDIT + VJ now, not Library. */}
          <button
            type="button"
            onClick={() => midiFileInputRef.current?.click()}
            className="p-1 rounded text-zinc-500 hover:text-purple-300"
            title="Import a .mid file → piano roll"
            aria-label="Import a .mid file into the piano roll"
          >
            <FileMusic className="w-3 h-3" />
          </button>
          <KnownFilesMenu id="library-import-midi-recent" exts={['.mid', '.midi']} label="Recent MIDI" onFiles={onLoadMidiFiles} />
          <button
            type="button"
            onClick={() => void handleImportFolder()}
            className="p-1 rounded text-zinc-500 hover:text-purple-300"
            title="Add a folder of audio to the library (files stay where they are)"
            aria-label="Import a folder into the library"
          >
            <FolderPlus className="w-3 h-3" />
          </button>
          <button
            type="button"
            aria-label="Import from a link"
            onClick={() => setLinkOpen((v) => !v)}
            className={`p-1 rounded ${linkOpen ? 'bg-white/10 text-purple-200' : 'text-zinc-500 hover:text-purple-300'}`}
            title="Import from link: YouTube, SoundCloud, Bandcamp or a direct audio URL"
            aria-expanded={linkOpen}
            aria-controls="library-link-import"
          >
            <Link2 className="w-3 h-3" />
          </button>
          <button type="button" aria-label="List view" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')} className={`p-1 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="List view">
            <ListIcon className="w-3 h-3" />
          </button>
          <button type="button" aria-label="Grid view" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')} className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="Grid view">
            <LayoutGrid className="w-3 h-3" />
          </button>
          {onExpand && (
            <button type="button" onClick={onExpand} className="p-1 rounded text-zinc-500 hover:text-teal-300" title="Expand to full library" aria-label="Expand to full library">
              <Maximize2 className="w-3 h-3" />
            </button>
          )}
        </div>
      }>
        {linkOpen && (
          <div id="library-link-import" className="px-2 py-1.5 flex flex-col gap-1 border-b border-white/5 bg-black/20">
            <div className="flex items-center gap-1 bg-black/40 border border-white/10 rounded px-1.5">
              <Link2 className="w-3 h-3 text-zinc-600 shrink-0" />
              <input
                id="library-link-import-url"
                name="library-link-import-url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void runLinkImport(); if (e.key === 'Escape') setLinkOpen(false); }}
                placeholder="paste a link…"
                disabled={linkBusy}
                aria-label="Import from link URL"
                autoFocus
                className="flex-1 min-w-0 bg-transparent text-[9px] font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void runLinkImport()}
                disabled={linkBusy || !linkUrl.trim()}
                className="shrink-0 text-purple-300 hover:text-purple-100 disabled:opacity-30"
                title="Download into the library"
                aria-label="Import link"
              >
                {linkBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              </button>
            </div>
            {linkErr && <span className="text-[8px] font-mono text-rose-400 px-1 truncate" title={linkErr}>{linkErr}</span>}
            <span className="text-[7px] font-mono text-zinc-600 px-1 leading-tight">YouTube · SoundCloud · Bandcamp · direct audio URL — Spotify is DRM-locked</span>
          </div>
        )}
        {/* Mic-in recorder. Hidden by default; toggled from the LIBRARY
            header. Saving to library triggers a refresh so the recording
            shows up immediately as a fresh import entry. */}
        {micOpen && (
          <div className="mb-2">
            <MicRecorder
              embedded
              onClose={() => setMicOpen(false)}
            />
          </div>
        )}

        <div className="shrink-0 flex flex-col gap-2 mb-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
            <input
              id="library-search"
              name="library-search"
              type="search"
              className="compact-input w-full pl-7"
              placeholder="SEARCH titles / prompts / tags / model / bpm / key / genre…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search the library"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
            <button
              type="button"
              aria-pressed={onlyFavorites}
              className={`mono-tag flex items-center gap-1 whitespace-nowrap ${onlyFavorites ?'bg-purple-600/20! text-purple-300! border-purple-500/40!' : 'bg-white/5! text-zinc-400!'}`}
              onClick={() => setOnlyFavorites(!onlyFavorites)}
            >
              <Star className="w-2 h-2 fill-current" /> FAVS
            </button>
            <button type="button" aria-pressed={sortBy === 'newest'} className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'newest' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('newest')}>
              <Clock className="w-2 h-2" /> NEWEST
            </button>
            <button type="button" aria-pressed={sortBy === 'duration'} className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'duration' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('duration')}>
              <Tag className="w-2 h-2" /> LENGTH
            </button>
            <button type="button" aria-pressed={sortBy === 'title'} className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'title' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('title')}>
              <Filter className="w-2 h-2" /> TITLE
            </button>
            <button type="button" aria-pressed={sortBy === 'plays'} className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'plays' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('plays')}>
              <Play className="w-2 h-2" /> PLAYS
            </button>
            <button type="button" className="mono-tag flex items-center gap-1 whitespace-nowrap bg-purple-600/30! text-purple-200! border border-purple-500/40" onClick={() => setSuggestOpen(true)} title="Suggest a playlist from your library">
              <Sparkles className="w-2 h-2" /> SUGGEST
            </button>
          </div>
        </div>

        {/* Sub-tabs: Tracks / Stems / MIDI / Video / Score — text-only per
            spec, no icons; GRAPH button removed (use the LEARN tab for the
            lineage graph instead). overflow-x-auto so the row never wraps and
            stays a single sticky strip above the scrolling lists. */}
        <div className="shrink-0 flex items-center gap-1 mb-2 border-b border-white/5 pb-1 overflow-x-auto no-scrollbar">
          <SubTabButton active={subTab === 'tracks'} onClick={() => setSubTab('tracks')}>
            {/* The strip counts the LIBRARY, not the current query, so it reads
                the T21 summary rather than the rows this view has loaded. */}
            Tracks ({tabCount(null, 'tracks')})
          </SubTabButton>
          <SubTabButton active={subTab === 'stems'} onClick={() => setSubTab('stems')}>
            Stems ({tabCount(allStems?.length, 'stems')})
          </SubTabButton>
          <SubTabButton active={subTab === 'midi'} onClick={() => setSubTab('midi')}>
            MIDI ({tabCount(allMidis?.length, 'midi')})
          </SubTabButton>
          <SubTabButton active={subTab === 'video'} onClick={() => setSubTab('video')}>
            Video ({tabCount(mediaEntries?.length, 'video')})
          </SubTabButton>
          <SubTabButton active={subTab === 'score'} onClick={() => setSubTab('score')}>
            Score ({tabCount(allScores?.length, 'score')})
          </SubTabButton>
          <SubTabButton active={subTab === 'info'} onClick={() => setSubTab('info')}>
            Info
          </SubTabButton>
          {countsStatus === 'error' && !libraryCounts && (
            <button
              type="button"
              onClick={() => { void useLibraryCounts.getState().load(); }}
              aria-label="Retry loading library counts"
              title={countsError ?? 'Library counts failed to load'}
              className="shrink-0 p-1 rounded border border-white/5 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RefreshCw className="w-2.5 h-2.5" />
            </button>
          )}
        </div>

        {/* THE scroll region: only the per-tab lists scroll; everything
            above (stats / search / filters / sub-tab strip) stays pinned.
            TRACKS does not scroll here — it is virtualized and owns its own
            scroll container — so the region is overflow-hidden on that tab.
            It is also the drop target for audio files from the desktop. */}
        <div
          ref={listRef}
          className={`flex-1 min-h-0 flex flex-col transition-colors ${subTab === 'tracks' || subTab === 'video' ? 'overflow-hidden' : 'overflow-y-auto no-scrollbar'} ${fileDragOver ? 'ring-1 ring-inset ring-purple-400/60 bg-purple-500/5' : ''}`}
          onDragOver={onListDragOver}
          onDragLeave={onListDragLeave}
          onDrop={onListDrop}
        >

        {subTab === 'tracks' && (<>
        {/* Icon-only top-level actions toolbar (user request 2026-05-28).
            Actions work on the SELECTION (a set of ids); SELECT toggles
            select-all over every row matching the current filters, which the
            server enumerates. Tooltips on hover (title attr) — names
            are not visible inline. */}
        <LibraryActionsToolbar
          selectedEntries={selectedEntries}
          selectedCount={selectedCount}
          totalCount={total}
          loadedEntries={entries}
          onToggleSelectAll={() => {
            if (selectedCount > 0) {
              setSelectedEntryIds(new Set());
              setSelectionAnchorId(null);
              setSelectionNotice(null);
              return;
            }
            void (async () => {
              try {
                const ids = await useLibraryStore.getState().listFilteredIds();
                setSelectedEntryIds(new Set(ids));
                setSelectionAnchorId(ids[0] ?? null);
                setSelectionNotice(null);
              } catch (e) {
                setSelectionNotice(
                  e instanceof LibraryIdCapError
                    ? e.message
                    : `Select-all failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            })();
          }}
          onDeleteSelected={async () => {
            const ids = [...selectedEntryIds];
            if (ids.length === 0) return;
            const ok = window.confirm(
              `Delete ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} from disk? This cannot be undone.`,
            );
            if (!ok) return;
            const { deleted, failed } = await useLibraryStore.getState().removeMany(ids);
            window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
            setSelectedEntryIds(new Set());
          }}
          onFuseSelected={handleSendSelectedToInit}
          onInpaintSelected={() => {
            const target = selectedEntries[0];
            if (!target) return;
            void handleSendToInpaint(target);
            onSwitchTab?.('create');
          }}
          onFetchMissingCovers={fetchMissingCovers}
          maintenanceCounts={maintenanceCounts}
          onOptionsOpen={() => { void refreshMaintenanceCounts(); }}
          onClearNonFavorites={async () => {
            // One request for the whole library, when the backend has the
            // route. The count in the question is the server's, and the server
            // re-counts before it deletes anything: if the library moved in
            // between it refuses, and the user is asked again with the new
            // number rather than having a stale promise carried out.
            const store = useLibraryStore.getState();
            if (store.bulkDeleteSupported && store.paged) {
              const kind = store.getQuery().kind;
              let counts = maintenanceCounts ?? (await refreshMaintenanceCounts());
              for (let attempt = 0; attempt < 2; attempt += 1) {
                if (!counts) break;
                if (counts.nonFavorites === 0) return;
                const ok = window.confirm(
                  `Delete ${counts.nonFavorites.toLocaleString()} non-favorite entr${counts.nonFavorites === 1 ? 'y' : 'ies'} from the library? Favorites and their audio files are kept.\n\nThis cannot be undone.`,
                );
                if (!ok) return;
                try {
                  const result = await store.bulkDelete({
                    filter: { favorite: false, kind },
                    confirmTotal: counts.nonFavorites,
                  });
                  if (result === null) break; // no route after all: fall through
                  setMaintenanceCounts(null);
                  window.alert(
                    `Removed ${result.deleted.toLocaleString()} entr${result.deleted === 1 ? 'y' : 'ies'}${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}.`,
                  );
                  return;
                } catch (e) {
                  if (e instanceof LibraryBulkConflictError) {
                    const notice = describeBulkConflict(e.totalMatched);
                    if (notice.total === null) {
                      // Unknown count — nothing safe to re-confirm with, and
                      // nothing here to overwrite `counts` with either; leave
                      // it as it was rather than storing NaN.
                      window.alert(notice.message);
                      return;
                    }
                    counts = { nonFavorites: notice.total, all: counts.all };
                    setMaintenanceCounts(counts);
                    continue;
                  }
                  window.alert(`Nothing was deleted: ${e instanceof Error ? e.message : String(e)}`);
                  return;
                }
              }
              if (counts) return;
            }
            // Old backend: exactly what it always did, over the rows in hand.
            const targets = entries.filter((e) => !e.favorite);
            if (targets.length === 0) return;
            const ok = window.confirm(
              `Delete ${targets.length} non-favorite loaded entr${targets.length === 1 ? 'y' : 'ies'} from disk? Favorites and their audio files are kept.`,
            );
            if (!ok) return;
            const { deleted, failed } = await useLibraryStore.getState().removeMany(targets.map((t) => t.id));
            window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
          }}
          onClearAll={async () => {
            const store = useLibraryStore.getState();
            if (store.bulkDeleteSupported && store.paged) {
              const counts = maintenanceCounts ?? (await refreshMaintenanceCounts());
              if (counts) {
                // Irreversible and unbounded: the user types the count back.
                setClearAllTotal(counts.all);
                return;
              }
            }
            const ok = window.confirm(
              `Delete the ${entries.length} loaded library entr${entries.length === 1 ? 'y' : 'ies'} including favorites from disk?\n\nThis cannot be undone.`,
            );
            if (!ok) return;
            const { deleted, failed } = await useLibraryStore.getState().clearAll();
            window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
          }}
        />

        {/* A select-all that hit the server's id cap, or a range that could
            not be resolved, says so here rather than silently doing less. */}
        {selectionNotice && (
          <div
            role="status"
            className="shrink-0 mx-1 mb-1 flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] font-mono text-amber-200"
          >
            <span className="flex-1 min-w-0">{selectionNotice}</span>
            <button
              type="button"
              onClick={() => setSelectionNotice(null)}
              className="shrink-0 text-amber-300 hover:text-amber-100"
              aria-label="Dismiss the selection message"
            >
              ✕
            </button>
          </div>
        )}

        {/* Slim loading bar while pages are in flight, announced once for
            anyone who cannot see it move. */}
        <div className="shrink-0 h-0.5 mx-1 mb-1 overflow-hidden rounded bg-white/5" role="status" aria-live="polite">
          {pagesLoading > 0 && (
            <>
              <span className="sr-only">Loading more tracks</span>
              <div className="h-full w-1/3 animate-pulse rounded bg-purple-500/70" aria-hidden="true" />
            </>
          )}
        </div>

        {/* A page that failed is an explicit row with a retry, never a blank. */}
        {pageError && (
          <div
            role="alert"
            className="shrink-0 mx-1 mb-1 flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[9px] font-mono text-rose-200"
          >
            <span className="flex-1 min-w-0 truncate" title={pageError}>{pageError}</span>
            <button
              type="button"
              onClick={() => { void useLibraryStore.getState().retryPages(); }}
              className="shrink-0 rounded border border-rose-400/40 px-1.5 py-0.5 text-rose-200 hover:bg-rose-500/20"
            >
              Retry
            </button>
          </div>
        )}

        {/* A track revealed from elsewhere whose position in this result set
            the server would not enumerate: shown here rather than not at all. */}
        {pinnedEntry && (
          <div className="shrink-0 mx-1 mb-1 rounded border border-purple-500/40 bg-purple-500/10 p-1.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-[10px] font-bold text-purple-200" title={pinnedEntry.title}>
                {pinnedEntry.title}
              </span>
              <button
                type="button"
                onClick={() => { void revealEntry(pinnedEntry.id); }}
                className="shrink-0 rounded border border-purple-400/40 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-purple-200 hover:bg-purple-500/20"
              >
                Jump to position
              </button>
              <button
                type="button"
                onClick={() => setPinnedEntry(null)}
                className="shrink-0 text-purple-300 hover:text-purple-100"
                aria-label="Stop pinning this track"
              >
                ✕
              </button>
            </div>
            <span className="mt-0.5 block text-[8px] font-mono text-zinc-500">
              Pinned — its position in this list is not known yet.
            </span>
          </div>
        )}

        <div className="shrink-0 flex items-center justify-between px-1 mb-1 text-[8px] font-mono text-zinc-600 uppercase border-b border-white/5 pb-1">
          <button type="button" className="flex items-center gap-1 hover:text-zinc-300" onClick={() => setSortBy('title')}>
            <ArrowUpDown className="w-2 h-2" /> NAME
          </button>
          <div className="flex gap-4">
            <span>MODEL</span>
            <span>LEN</span>
            <span>DATE</span>
          </div>
        </div>

        {/* The virtualized list. Row indices are GLOBAL indices into the
            result set, so scrolling to row 150,000 costs one page fetch and
            not a 200,000-row render. `onRowsRendered` is what asks for the
            pages a scroll position needs. */}
        <div className="flex-1 min-h-0">
          {total === 0 && pagesLoading === 0 && !pageError ? (
            <div className="py-8 flex flex-col items-center justify-center opacity-30 italic gap-2">
              <Database className="w-8 h-8" />
              {searchQuery.trim() || onlyFavorites ? (
                <p>No entries match your filter.</p>
              ) : (
                <>
                  <p>Library is empty.</p>
                  <button
                    type="button"
                    className="mono-tag bg-purple-600/20! text-purple-300! border-purple-500/40! cursor-pointer"
                    onClick={() => onSwitchTab?.('create')}
                  >
                    Go generate something
                  </button>
                </>
              )}
            </div>
          ) : (
            <List
              className="no-scrollbar"
              listRef={trackListRef}
              rowComponent={TrackRow}
              rowCount={Math.ceil(total / perRow)}
              rowHeight={trackRowHeight}
              rowProps={trackRowProps}
              overscanCount={TRACK_OVERSCAN}
              onRowsRendered={handleRowsRendered}
              onResize={handleListResize}
              onKeyDown={onTracksKeyDown}
              tabIndex={0}
              aria-label="Library tracks"
              style={{ height: '100%' }}
            />
          )}
        </div>
        </>)}

        {subTab === 'stems' && (<>
          {selectedEntry && missingFor(stemsByParent, allStems) && (
            <NothingForTrack
              entryId={selectedEntry.id}
              title={selectedEntry.title}
              what="stems"
              action={{
                label: runningKind?.id === selectedEntry.id && runningKind.kind === 'stems' ? 'Running stems…' : 'Separate stems…',
                icon: <Scissors className="size-3.5" aria-hidden="true" />,
                disabled: runningKind?.id === selectedEntry.id && runningKind.kind === 'stems',
                onClick: () => setStemsModal({ entryId: selectedEntry.id, entryTitle: selectedEntry.title }),
              }}
            />
          )}
          <SubTabList
            byParent={stemsByParent}
            parentTitles={parentTitles}
            kind="stem"
            placeholder={allStems === null ? 'Loading stems…' : 'No stems yet. Enable auto-stems in Settings or right-click a track → Separate stems.'}
            onMutated={refreshStems}
            selectedId={selectedEntryId}
            onSelectParent={selectEntryById}
          />
        </>)}
        {subTab === 'midi' && (<>
          {selectedEntry && missingFor(midisByParent, allMidis) && (
            <NothingForTrack
              entryId={selectedEntry.id}
              title={selectedEntry.title}
              what="MIDI"
              action={{
                label: runningKind?.id === selectedEntry.id && runningKind.kind === 'midi' ? 'Running MIDI…' : 'Convert to MIDI',
                icon: <FileMusic className="size-3.5" aria-hidden="true" />,
                disabled: runningKind?.id === selectedEntry.id && runningKind.kind === 'midi',
                onClick: () => { void runJobForEntry(selectedEntry.id, 'midi'); },
              }}
            />
          )}
          <SubTabList
            byParent={midisByParent}
            parentTitles={parentTitles}
            kind="midi"
            placeholder={allMidis === null ? 'Loading MIDI…' : 'No MIDI yet. Enable auto-MIDI in Settings or right-click a track → Convert to MIDI.'}
            onMutated={refreshMidi}
            selectedId={selectedEntryId}
            onSelectParent={selectEntryById}
          />
        </>)}
        {subTab === 'video' && (
          <MediaGrid
            entries={mediaEntries}
            onChanged={refreshMedia}
          />
        )}
        {subTab === 'score' && (<>
          {selectedEntry && missingFor(scoresByParent, allScores) && (
            <NothingForTrack
              entryId={selectedEntry.id}
              title={selectedEntry.title}
              what="scores"
              action={{
                label: 'Open in SCORE',
                icon: <FileMusic className="size-3.5" aria-hidden="true" />,
                onClick: () => openScoreForEntry(selectedEntry.id),
              }}
            />
          )}
          <ScoreList
            byParent={scoresByParent}
            parentTitles={parentTitles}
            placeholder={allScores === null
              ? 'Loading scores…'
              : 'No scores yet. Open a track in SCORE, pick an instrument and press MAKE, or import a score file or a corpus piece there.'}
            onOpen={openScoreForEntry}
            onRefresh={refreshScores}
            selectedId={selectedEntryId}
            onSelectParent={selectEntryById}
          />
        </>)}
        {subTab === 'info' && (
          <TrackInfo
            entryId={selectedEntryId}
            stems={allStems === null ? null : (selectedEntryId ? stemsByParent[selectedEntryId] ?? [] : [])}
            midis={allMidis === null ? null : (selectedEntryId ? midisByParent[selectedEntryId] ?? [] : [])}
            scores={allScores === null ? null : (selectedEntryId ? scoresByParent[selectedEntryId] ?? [] : [])}
            onOpenDetails={openDetailsForEntry}
            onOpenLineage={(id) => setLineageOpen(id)}
            onSelectEntry={selectEntryById}
          />
        )}
        </div>
      </Section>

      {(() => {
        const ctxEntryId = entryMenu.payload?.entryId;
        if (!ctxEntryId) return null;
        // Captured while the parent menu is open; the convert picker reopens here
        // (onSelect runs after the parent menu has already closed itself).
        const ctxPos = entryMenu.position;
        const isRunning = (k: 'analysis' | 'stems' | 'midi') =>
          runningKind?.id === ctxEntryId && runningKind?.kind === k;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Send selected to Init',
            icon: <Wand2 className="w-3 h-3" />,
            hint: selectedEntries.length > 1 ? `${selectedEntries.length} → Chimera` : 'single',
            disabled: selectedEntries.length === 0,
            onSelect: handleSendSelectedToInit,
          },
          { type: 'separator' },
          {
            type: 'item',
            label: isRunning('analysis') ? 'Running analysis…' : 'Run analysis',
            icon: isRunning('analysis')
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Activity className="w-3 h-3" />,
            hint: 'bpm/key/pitch',
            disabled: isRunning('analysis'),
            onSelect: () => { void runJobForEntry(ctxEntryId, 'analysis'); },
          },
          {
            type: 'item',
            label: isRunning('stems') ? 'Running stems…' : 'Separate stems…',
            icon: isRunning('stems')
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Scissors className="w-3 h-3" />,
            hint: 'demucs',
            disabled: isRunning('stems'),
            onSelect: () => {
              const title = getById(ctxEntryId)?.title ?? ctxEntryId;
              setStemsModal({ entryId: ctxEntryId, entryTitle: title });
            },
          },
          {
            type: 'item',
            label: isRunning('midi') ? 'Running MIDI…' : 'Convert to MIDI',
            icon: isRunning('midi')
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <FileMusic className="w-3 h-3" />,
            hint: 'basic-pitch',
            disabled: isRunning('midi'),
            onSelect: () => { void runJobForEntry(ctxEntryId, 'midi'); },
          },
          {
            type: 'item',
            label: 'Fetch cover art',
            icon: <ImageIcon className="w-3 h-3" />,
            hint: 'embedded',
            onSelect: () => { void fetchCoverForEntry(ctxEntryId); },
          },
          {
            type: 'item',
            label: 'Open details',
            icon: <Info className="w-3 h-3" />,
            hint: 'DETAILS tab',
            onSelect: () => openDetailsForEntry(ctxEntryId),
          },
          {
            type: 'item',
            label: 'Open Score / Notation',
            icon: <FileMusic className="w-3 h-3" />,
            hint: 'MusicXML',
            onSelect: () => openScoreForEntry(ctxEntryId),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Download audio',
            icon: <Download className="w-3 h-3" />,
            hint: 'file',
            onSelect: () => {
              const entry = getById(ctxEntryId);
              void saveFile({
                url: `/api/library/audio/${ctxEntryId}`,
                suggestedName: entry ? entryFileName(entry) : fileSafe(ctxEntryId),
                kind: entry ? entryKind(entry) : 'audio',
              });
            },
          },
          {
            type: 'item',
            label: 'Convert to…',
            icon: <Repeat className="w-3 h-3" />,
            hint: 'ffmpeg',
            onSelect: () => {
              const title = getById(ctxEntryId)?.title ?? ctxEntryId;
              if (ctxPos) convertMenu.openAt(ctxPos, { entryId: ctxEntryId, title, kind: 'audio' });
            },
          },
          {
            type: 'item',
            label: 'Download bundle',
            icon: <Package className="w-3 h-3" />,
            hint: '.zip+scores',
            onSelect: () => {
              const title = getById(ctxEntryId)?.title ?? '';
              void saveFile({
                url: `/api/library/${ctxEntryId}/bundle`,
                suggestedName: bundleFileName(ctxEntryId, title),
                kind: 'zip',
              });
            },
          },
          {
            type: 'item',
            label: 'Show lineage',
            icon: <Network className="w-3 h-3" />,
            hint: 'graph',
            onSelect: () => setLineageOpen(ctxEntryId),
          },
        ];
        return (
          <ContextMenu
            position={entryMenu.position}
            onClose={entryMenu.close}
            items={items}
            title={selectedEntries.length > 1 ? `${selectedEntries.length} selected` : '1 selected'}
            minWidth="13rem"
          />
        );
      })()}

      {convertMenu.element}

      <LineageModal
        open={lineageOpen !== null}
        rootEntryId={lineageOpen === '__library__' ? null : lineageOpen}
        onClose={() => setLineageOpen(null)}
      />

      <SuggestPlaylistModal open={suggestOpen} onClose={() => setSuggestOpen(false)} />

      {clearAllTotal !== null && (
        <ClearAllDialog
          total={clearAllTotal}
          busy={clearAllBusy}
          onCancel={() => setClearAllTotal(null)}
          onConfirm={() => {
            void (async () => {
              setClearAllBusy(true);
              try {
                const result = await useLibraryStore.getState().bulkDelete({
                  filter: {},
                  confirmTotal: clearAllTotal,
                  all: true,
                });
                setClearAllTotal(null);
                setMaintenanceCounts(null);
                if (result === null) {
                  window.alert('This backend cannot delete in bulk — nothing was deleted.');
                  return;
                }
                window.alert(
                  `Removed ${result.deleted.toLocaleString()} entr${result.deleted === 1 ? 'y' : 'ies'}${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}.`,
                );
              } catch (e) {
                // A 409 means the library moved: re-ask with the count it has
                // now, so the typed number is one the server will accept.
                if (e instanceof LibraryBulkConflictError) {
                  const notice = describeBulkConflict(e.totalMatched);
                  // Unknown count (server omitted it): leave `clearAllTotal`
                  // as it was rather than storing NaN — there is nothing
                  // valid to re-confirm with anyway.
                  if (notice.total !== null) setClearAllTotal(notice.total);
                  setMaintenanceCounts(null);
                  window.alert(notice.message);
                  return;
                }
                setClearAllTotal(null);
                window.alert(`Nothing was deleted: ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setClearAllBusy(false);
              }
            })();
          }}
        />
      )}

      {/* Maintenance actions (Clear Non-Favorites / Clear All) moved
          into the icon toolbar's OPTIONS submenu per user request
          2026-05-28. Section removed entirely. */}

    </div>
  );
};


interface LibraryActionsToolbarProps {
  /** The selected rows we HOLD — a selection can name rows on unloaded pages. */
  selectedEntries: LibraryEntry[];
  /** How many ids are selected, loaded or not. */
  selectedCount: number;
  /** Rows matching the current filters, across every page. */
  totalCount: number;
  /** The rows currently loaded — what maintenance actions can act on. */
  loadedEntries: LibraryEntry[];
  /**
   * Whole-library counts for the two Clear actions, or null when this backend
   * can only delete one row per request — the labels then say "loaded", which
   * is all those actions can honestly promise.
   */
  maintenanceCounts: MaintenanceCounts | null;
  /** The OPTIONS menu is opening: a good moment to (re)count the library. */
  onOptionsOpen: () => void;
  onToggleSelectAll: () => void;
  onDeleteSelected: () => void | Promise<void>;
  onFuseSelected: () => void;
  onInpaintSelected: () => void;
  onFetchMissingCovers: () => void | Promise<void>;
  onClearNonFavorites: () => void | Promise<void>;
  onClearAll: () => void | Promise<void>;
}

/** Icon-only top-level library actions bar. Names render as tooltips
 *  only (mouseover). DOWNLOAD + OPTIONS open ContextMenu submenus
 *  anchored to the click. Empty selection disables destructive actions
 *  (delete / fuse / inpaint) but leaves SELECT / DOWNLOAD / OPTIONS
 *  usable so the user can act on the visible set without selecting
 *  first. */
const LibraryActionsToolbar: React.FC<LibraryActionsToolbarProps> = ({
  selectedEntries,
  selectedCount,
  totalCount,
  loadedEntries,
  maintenanceCounts,
  onOptionsOpen,
  onToggleSelectAll,
  onDeleteSelected,
  onFuseSelected,
  onInpaintSelected,
  onFetchMissingCovers,
  onClearNonFavorites,
  onClearAll,
}) => {
  const downloadMenu = useContextMenu<'download'>();
  const optionsMenu = useContextMenu<'options'>();
  const selCount = selectedCount;
  const hasSelection = selCount > 0;
  const allSelected = totalCount > 0 && selCount >= totalCount;

  // For DOWNLOAD: the target set is the selected rows when there are any,
  // otherwise the rows in hand (so the user gets a "bulk download everything
  // on screen" affordance without having to click SELECT first). Both are
  // rows we HOLD: a download needs the record, not just the id. DELETE
  // always requires explicit selection — too destructive to default-target.
  const downloadTargets = hasSelection ? selectedEntries : loadedEntries;

  // One Save As per file, in order; cancelling one stops the rest. A browser on
  // another machine gets an ordinary download of each file.
  const downloadAll = async (kind: 'song' | 'midi' | 'json' | 'bundle' | 'lineage') => {
    for (const entry of [...downloadTargets]) {
      let result: { cancelled: boolean };
      if (kind === 'song') {
        // The entry's audio blob lives at this server-relative URL.
        result = await saveEntryFile(entry, `/api/library/audio/${entry.id}`);
      } else if (kind === 'midi') {
        // The whole-mix conversion is the MIDI row `<entry id>__full`
        // (backend/modules/midi/runner.py). Its bytes are fetched first so an
        // entry with no conversion is skipped before any dialog opens.
        const res = await fetch(`/api/midi/file/${encodeURIComponent(`${entry.id}__full`)}`).catch(() => null);
        const blob = res?.ok ? await res.blob().catch(() => null) : null;
        if (!blob) {
          logWarn('library', `"${entry.title}" has no MIDI conversion yet, so it was skipped.`);
          continue;
        }
        result = await saveFile({ blob, suggestedName: withExt(entry.title, '.mid'), kind: 'midi' });
      } else if (kind === 'bundle') {
        result = await saveFile({
          url: `/api/library/${entry.id}/bundle`,
          suggestedName: withExt(entry.title, '.zip'),
          kind: 'zip',
        });
      } else if (kind === 'lineage') {
        result = await saveFile({
          url: `/api/library/${entry.id}/lineage?depth=8`,
          suggestedName: `${fileSafe(entry.title)}-lineage.json`,
          kind: 'lineage-json',
        });
      } else {
        // Build a metadata JSON client-side from what the store already
        // has cached — no backend round-trip. If the user needs the
        // server's canonical view they can use Bundle.
        const blob = new Blob([JSON.stringify(entry, null, 2)], {
          type: 'application/json',
        });
        result = await saveFile({ blob, suggestedName: withExt(entry.title, '.json'), kind: 'library-metadata' });
      }
      if (result.cancelled) break;
    }
  };

  const downloadItems: ContextMenuItem[] = [
    { type: 'header', label: `${downloadTargets.length} ${hasSelection ? 'selected' : 'visible'}` },
    {
      type: 'item',
      label: 'Songs (audio file)',
      icon: <Music className="w-3 h-3" />,
      hint: downloadTargets.length > 0 ? `${downloadTargets.length} files` : undefined,
      disabled: downloadTargets.length === 0,
      onSelect: () => void downloadAll('song'),
    },
    {
      type: 'item',
      label: 'MIDI (.mid)',
      icon: <FileMusic className="w-3 h-3" />,
      disabled: downloadTargets.length === 0,
      onSelect: () => void downloadAll('midi'),
    },
    {
      type: 'item',
      label: 'Metadata JSON',
      icon: <FileText className="w-3 h-3" />,
      disabled: downloadTargets.length === 0,
      onSelect: () => void downloadAll('json'),
    },
    {
      type: 'item',
      label: 'Bundle (.zip)',
      icon: <Package className="w-3 h-3" />,
      hint: 'audio+meta+midi',
      disabled: downloadTargets.length === 0,
      onSelect: () => void downloadAll('bundle'),
    },
    {
      type: 'item',
      label: 'Lineage report',
      icon: <Network className="w-3 h-3" />,
      hint: 'JSON graph',
      disabled: downloadTargets.length === 0,
      onSelect: () => void downloadAll('lineage'),
    },
  ];

  // Cover art still walks the rows in hand one at a time, and its label says
  // so. The two Clear actions delete in ONE request against a backend that has
  // the bulk route, so their labels carry the server's whole-library counts —
  // and fall back to the honest "loaded" wording when it does not.
  const missingCovers = loadedEntries.filter((e) => !e.coverUrl).length;
  const nonFavorites = loadedEntries.filter((e) => !e.favorite).length;
  const clearNonFavoritesLabel = maintenanceCounts
    ? `Clear non-favorites (${maintenanceCounts.nonFavorites.toLocaleString()})`
    : `Clear non-favorites (${nonFavorites} loaded)`;
  const clearAllLabel = maintenanceCounts
    ? `Clear all (${maintenanceCounts.all.toLocaleString()})`
    : `Clear loaded (${loadedEntries.length})`;
  const optionsItems: ContextMenuItem[] = [
    { type: 'header', label: maintenanceCounts ? 'Library maintenance' : 'Library maintenance · loaded rows' },
    {
      type: 'item',
      label: `Fetch cover art (${missingCovers} without)`,
      icon: <ImageIcon className="w-3 h-3" />,
      hint: 'embedded art',
      disabled: missingCovers === 0,
      onSelect: () => void onFetchMissingCovers(),
    },
    { type: 'separator' },
    {
      type: 'item',
      label: clearNonFavoritesLabel,
      icon: <Trash2 className="w-3 h-3" />,
      disabled: maintenanceCounts ? maintenanceCounts.nonFavorites === 0 : nonFavorites === 0,
      onSelect: () => void onClearNonFavorites(),
    },
    {
      type: 'item',
      label: clearAllLabel,
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      disabled: maintenanceCounts ? maintenanceCounts.all === 0 : loadedEntries.length === 0,
      onSelect: () => void onClearAll(),
    },
  ];

  const baseBtn =
    'p-1.5 rounded border transition-colors flex items-center gap-1 disabled:opacity-30 disabled:pointer-events-none';
  const idleBtn = `${baseBtn} border-white/5 text-zinc-400 hover:text-zinc-100 hover:bg-white/5`;
  const activeBtn = `${baseBtn} border-purple-500/40 text-purple-200 bg-purple-500/10 hover:bg-purple-500/20`;
  const dangerBtn = `${baseBtn} border-red-500/30 text-red-300 hover:bg-red-500/15`;

  return (
    <div className="flex items-center justify-between gap-1 px-1 mb-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleSelectAll}
          className={allSelected ? activeBtn : idleBtn}
          title={
            hasSelection
              ? `Clear the selection (${selCount.toLocaleString()} selected)`
              : `Select all ${totalCount.toLocaleString()} matching entries`
          }
          aria-label={hasSelection ? 'Clear the selection' : 'Select every matching entry'}
        >
          {hasSelection ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={(e) => downloadMenu.open(e, 'download')}
          className={idleBtn}
          title={`Download${hasSelection ? ` (${selCount} selected)` : ' (visible)'}…`}
          aria-label="Download menu"
        >
          <Download className="w-3.5 h-3.5" />
          <ChevronDown className="w-2.5 h-2.5 opacity-60" />
        </button>
        <button
          type="button"
          onClick={() => void onDeleteSelected()}
          disabled={!hasSelection}
          className={hasSelection ? dangerBtn : idleBtn}
          title={hasSelection ? `Delete ${selCount} selected` : 'Delete (select tracks first)'}
          aria-label="Delete selected"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onFuseSelected}
          disabled={!hasSelection}
          className={idleBtn}
          title={
            hasSelection
              ? selCount === 1
                ? 'FUSE: Send to Init'
                : `FUSE: Chimera-stack ${selCount} selected`
              : 'FUSE (select tracks first)'
          }
          aria-label="Fuse selected"
        >
          <Combine className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onInpaintSelected}
          disabled={!hasSelection}
          className={idleBtn}
          title={
            hasSelection
              ? selCount > 1
                ? 'INPAINT (first selected only)'
                : 'INPAINT this track'
              : 'INPAINT (select a track first)'
          }
          aria-label="Inpaint selected"
        >
          <Paintbrush className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { onOptionsOpen(); optionsMenu.open(e, 'options'); }}
          className={idleBtn}
          title="More options…"
          aria-label="More options"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
      <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600 pr-1">
        {hasSelection
          ? `${selCount.toLocaleString()}/${totalCount.toLocaleString()} sel`
          : `${totalCount.toLocaleString()} match`}
      </span>

      <ContextMenu
        position={downloadMenu.position}
        onClose={downloadMenu.close}
        items={downloadItems}
        title="Download"
        minWidth="14rem"
      />
      <ContextMenu
        position={optionsMenu.position}
        onClose={optionsMenu.close}
        items={optionsItems}
        title="Options"
        minWidth="14rem"
      />
    </div>
  );
};


interface SubTabButtonProps {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const SubTabButton: React.FC<SubTabButtonProps> = ({ active, onClick, icon, children }) => (
  <button
    type="button"
    aria-pressed={active}
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
      active
        ? 'bg-purple-500/15 border-purple-500/40 text-purple-200'
        : 'border-white/5 text-zinc-500 hover:text-zinc-300'
    }`}
  >
    {icon}
    {children}
  </button>
);


/* ═══════════════════════════════ MediaGrid ════════════════════════════════ */

/** `rowProps` for the virtualized media grid. */
interface MediaRowData {
  entries: LibraryEntry[];
  onRemove: (entry: LibraryEntry) => void;
  onSendToVj: (entry: LibraryEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: LibraryEntry) => void;
}

/** One line of the media grid: `GRID_COLUMNS` cards, or fewer at the end. */
function MediaRow({ index, style, ariaAttributes, entries, onRemove, onSendToVj, onContextMenu }: RowComponentProps<MediaRowData>) {
  const first = index * GRID_COLUMNS;
  const cells: React.ReactNode[] = [];
  for (let column = 0; column < GRID_COLUMNS; column += 1) {
    const entry = entries[first + column];
    if (!entry) break;
    cells.push(
      <MediaCard
        key={entry.id}
        entry={entry}
        onRemove={() => onRemove(entry)}
        onSendToVj={() => onSendToVj(entry)}
        onContextMenu={(e) => onContextMenu(e, entry)}
      />,
    );
  }
  return (
    <div style={style} {...ariaAttributes} className="grid grid-cols-2 gap-2 pb-2">
      {cells}
    </div>
  );
}

/** VJ video library: a thumbnail grid of imported video/image entries with
 *  an import button. Videos and alpha-capable media (transparent PNG/WebP,
 *  alpha WebM) are badged so overlay-capable clips are identifiable. Entries
 *  persist server-side, so the VJ cue survives reloads once routed here. */
const MediaGrid: React.FC<{
  entries: LibraryEntry[] | null;
  onChanged: () => Promise<void>;
}> = ({ entries, onChanged }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const mediaMenu = useContextMenu<LibraryEntry>();
  const convertMenu = useConvertMenu({
    onStart: (m) => logInfo('library', m),
    onError: (m) => logError('library', m),
  });

  // Fed by the file input and the Recent list alike.
  const onPick = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    let ok = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await importMedia(file);
        ok += 1;
      } catch (e) {
        failed += 1;
        logError('library', `Media import failed for ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setUploading(false);
    if (ok) logInfo('library', `Imported ${ok} media file${ok === 1 ? '' : 's'} into the library.`);
    await onChanged();
  };

  const onRemove = React.useCallback(async (entry: LibraryEntry) => {
    try {
      await deleteMedia(entry.id);
      await onChanged();
    } catch (e) {
      logError('library', `Media delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onChanged]);

  const sendToVj = React.useCallback((entry: LibraryEntry) => {
    sendTrackToVj({
      entryId: entry.id,
      label: entry.title,
      url: entry.mediaUrl ?? entry.audioUrl,
      kind: entry.kind === 'image' ? 'image' : 'video',
      thumbUrl: entry.thumbUrl ?? null,
    });
    logInfo('library', `Sent "${entry.title}" to the VJ.`);
  }, []);

  // A media card is `aspect-video` with a one-line title under it, so a row is
  // as tall as half the measured width in 16:9, plus that footer and the gap.
  const [mediaWidth, setMediaWidth] = useState(0);
  const handleMediaResize = React.useCallback(
    (size: { width: number; height: number }) => setMediaWidth(size.width),
    [],
  );
  const mediaRowHeight = Math.max(
    72,
    Math.round(((mediaWidth - GRID_GAP) / GRID_COLUMNS) * (9 / 16)) + 29,
  );
  const mediaRowProps = useMemo<MediaRowData>(() => ({
    entries: entries ?? [],
    onRemove: (entry: LibraryEntry) => { void onRemove(entry); },
    onSendToVj: sendToVj,
    onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => mediaMenu.open(e, entry),
  }), [entries, onRemove, sendToVj, mediaMenu]);

  const ctxEntry = mediaMenu.payload;
  const ctxPos = mediaMenu.position;
  const menuItems: ContextMenuItem[] = ctxEntry
    ? [
        {
          type: 'item',
          label: 'Send to VJ',
          icon: <Film className="w-3 h-3" />,
          hint: 'live visuals',
          onSelect: () => sendToVj(ctxEntry),
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Download',
          icon: <Download className="w-3 h-3" />,
          onSelect: () => { void saveEntryFile(ctxEntry, ctxEntry.mediaUrl ?? ctxEntry.audioUrl); },
        },
        {
          type: 'item',
          label: 'Convert to…',
          icon: <Repeat className="w-3 h-3" />,
          hint: 'ffmpeg',
          onSelect: () => {
            if (ctxPos) {
              convertMenu.openAt(ctxPos, {
                entryId: ctxEntry.id,
                title: ctxEntry.title,
                kind: ctxEntry.kind ?? 'video',
              });
            }
          },
        },
        {
          type: 'item',
          label: 'Copy media link',
          icon: <FileText className="w-3 h-3" />,
          onSelect: () => {
            // backendHttpBase, not window.location.origin: a copied link is
            // for OUTSIDE this window, and the packaged app's app://. origin
            // resolves nowhere else.
            void navigator.clipboard?.writeText(
              new URL(ctxEntry.mediaUrl ?? ctxEntry.audioUrl, backendHttpBase()).toString(),
            );
          },
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Delete',
          icon: <Trash2 className="w-3 h-3" />,
          danger: true,
          onSelect: () => { void onRemove(ctxEntry); },
        },
      ]
    : [];

  return (
    // A flex column so the virtualized grid below can fill what the header
    // leaves, which is what gives the List a bounded height to window into.
    <div className="px-1 flex flex-1 flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between mb-2">
        <span className="text-[9px] font-mono text-zinc-600">
          Videos and images for the VJ tab. Transparent media can act as overlays.
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest border border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25 disabled:opacity-50 transition-colors"
          >
            {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {uploading ? 'Importing…' : 'Import media'}
          </button>
          <KnownFilesMenu
            id="media-import-recent"
            exts={MEDIA_ACCEPT.split(',')}
            label="Recent media"
            onFiles={(files) => void onPick(files)}
          />
        </div>
        <label htmlFor="media-import-input" className="sr-only">Import video or image files</label>
        <input
          ref={fileInputRef}
          id="media-import-input"
          name="media-import-input"
          type="file"
          accept={MEDIA_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void onPick(files);
          }}
        />
      </div>

      {entries === null ? (
        <div className="flex items-center gap-2 text-[10px] text-zinc-500 py-8 justify-center">
          <Loader2 size={12} className="animate-spin" /> Loading media…
        </div>
      ) : entries.length === 0 ? (
        <div className="text-[10px] text-zinc-600 py-8 text-center">
          No media yet. Import videos or images, or load clips in the VJ tab — they are saved here.
        </div>
      ) : (
        // Virtualized for the same reason the tracks list is: a VJ library of
        // video clips is as long as the user's disk, and one <video> poster
        // per row is far more expensive than one audio card.
        <div className="flex-1 min-h-0">
          <List
            className="no-scrollbar"
            rowComponent={MediaRow}
            rowCount={Math.ceil(entries.length / GRID_COLUMNS)}
            rowHeight={mediaRowHeight}
            rowProps={mediaRowProps}
            overscanCount={TRACK_OVERSCAN}
            onResize={handleMediaResize}
            aria-label="Video and image library"
            style={{ height: '100%' }}
          />
        </div>
      )}

      <ContextMenu
        position={mediaMenu.position}
        onClose={mediaMenu.close}
        items={menuItems}
        title={ctxEntry ? ctxEntry.title : ''}
      />
      {convertMenu.element}
    </div>
  );
};

const MediaCard: React.FC<{
  entry: LibraryEntry;
  onRemove: () => void;
  onSendToVj: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}> = ({ entry, onRemove, onSendToVj, onContextMenu }) => {
  const isVideo = entry.kind === 'video';
  const mediaUrl = entry.mediaUrl ?? entry.audioUrl;
  return (
    <div
      className="group relative rounded-lg overflow-hidden border border-white/8 bg-black/40"
      draggable
      onContextMenu={onContextMenu}
      title="Drag onto the VJ tab to add it · right-click for actions"
      onDragStart={(e) => {
        // Stable URL so a drop target (the VJ tab's drop zone, or any
        // consumer) can reference the persisted file rather than a session blob.
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/uri-list', mediaUrl);
        e.dataTransfer.setData(
          'application/x-thedaw-media',
          JSON.stringify({
            id: entry.id,
            url: mediaUrl,
            kind: entry.kind ?? 'video',
            name: entry.title,
            hasAlpha: !!entry.hasAlpha,
          }),
        );
      }}
    >
      <div className="aspect-video bg-black/60 flex items-center justify-center overflow-hidden">
        {entry.thumbUrl ? (
          <img
            src={entry.thumbUrl}
            alt={`Thumbnail for ${entry.title}`}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="text-zinc-700">
            {isVideo ? <Film size={28} /> : <ImageIcon size={28} />}
          </div>
        )}
      </div>

      {/* Badges */}
      <div className="absolute top-1 left-1 flex items-center gap-1">
        <span className="flex items-center gap-1 px-1 py-0.5 rounded bg-black/70 text-[8px] font-black uppercase tracking-wider text-zinc-300">
          {isVideo ? <Film size={9} /> : <ImageIcon size={9} />}
          {isVideo ? 'Video' : 'Image'}
        </span>
        {entry.hasAlpha && (
          <span
            className="px-1 py-0.5 rounded bg-fuchsia-500/30 text-[8px] font-black uppercase tracking-wider text-fuchsia-200"
            title="Transparent — usable as an overlay"
          >
            Alpha
          </span>
        )}
      </div>

      {/* Action buttons — top-right corner so they never sit under the
          duration badge (bottom-right). Hover-revealed; dark pill so the
          icons read over any thumbnail. */}
      <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-black/70 px-0.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSendToVj(); }}
          aria-label={`Send ${entry.title} to the VJ`}
          title="Send to VJ"
          className="p-0.5 rounded text-fuchsia-300 hover:text-fuchsia-100 hover:bg-white/10"
        >
          <Tv2 size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void saveEntryFile(entry, mediaUrl); }}
          aria-label={`Save ${entry.title}`}
          title="Save this file to a folder you choose."
          className="p-0.5 rounded text-zinc-300 hover:text-white hover:bg-white/10"
        >
          <Download size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`Remove ${entry.title} from the media library`}
          className="p-0.5 rounded text-zinc-300 hover:text-red-400 hover:bg-white/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {isVideo && entry.duration > 0 && (
        <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 text-[8px] font-mono text-zinc-300">
          {formatDuration(entry.duration)}
        </span>
      )}

      {/* Footer: title */}
      <div className="px-1.5 py-1">
        <span className="text-[9px] text-zinc-300 truncate block" title={entry.title}>{entry.title}</span>
      </div>
    </div>
  );
};


/** A song's group in Stems / MIDI / Score, ringed when it is the selected track. */
const groupFrame = (selected: boolean): string =>
  `rounded border p-2 bg-white/3 ${selected ? 'border-purple-500/60 ring-1 ring-purple-500/60' : 'border-white/5'}`;

/** A group's song title; a click selects that song. A group whose song has
 *  left the library shows its id and cannot be selected. */
const GroupTitle: React.FC<{
  title: string | undefined;
  fallback: string;
  selected: boolean;
  tone: string;
  onSelect: () => void;
}> = ({ title, fallback, selected, tone, onSelect }) =>
  title ? (
    <button
      type="button"
      className={`mb-1 block w-full truncate text-left text-xs font-bold uppercase tracking-wider ${tone} hover:text-zinc-100`}
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={`Select ${title}`}
    >
      {title}
    </button>
  ) : (
    <div className={`mb-1 truncate text-xs font-bold uppercase tracking-wider ${tone}`}>{fallback}</div>
  );

/** The selected track has nothing in this tab: say so at the top of the list,
 *  with the key that makes it. */
const NothingForTrack: React.FC<{
  entryId: string;
  title: string;
  what: string;
  action: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean };
}> = ({ entryId, title, what, action }) => (
  <div data-follow-id={entryId} className="mb-2 flex flex-col gap-1.5 rounded border border-purple-500/60 bg-purple-500/6 p-2 ring-1 ring-purple-500/60">
    <span className="truncate text-xs font-bold uppercase tracking-wider text-purple-300" title={title}>
      {title}
    </span>
    <span className="text-xs font-bold text-zinc-400">No {what} for this track yet.</span>
    <button
      type="button"
      className="flex items-center gap-1.5 self-start rounded border border-white/10 px-2 py-1 text-xs font-bold text-zinc-200 transition-colors hover:border-purple-400/50 hover:text-zinc-100 disabled:opacity-40"
      onClick={action.onClick}
      disabled={action.disabled}
    >
      {action.icon}
      {action.label}
    </button>
  </div>
);

interface SubTabListProps {
  byParent: Record<string, Array<Record<string, unknown>>>;
  parentTitles: Record<string, string>;
  kind: 'stem' | 'midi';
  placeholder: string;
  /** Re-fetch the index in place after a favorite toggle or delete. */
  onMutated: () => void | Promise<void>;
  /** The library's selected track, whose group is marked. */
  selectedId: string | null;
  /** Select a group's track. */
  onSelectParent: (entryId: string) => void;
}

type SubTabRowPayload =
  | { kind: 'midi'; midiId: string; label: string }
  | { kind: 'stem'; row: Record<string, unknown> };

/**
 * One stem/MIDI row, memoized so opening the right-click menu (or any other
 * parent state change) doesn't re-render the whole hundreds-of-rows list — that
 * full re-render was the 600ms+ contextmenu/mousedown jank. Props are stable
 * (the row object, plus stable callbacks), so React.memo skips untouched rows.
 */
const SubTabRow = React.memo<{
  row: Record<string, unknown>;
  isMidi: boolean;
  parentTitle: string;
  isPlaying: boolean;
  isBusy: boolean;
  onPlay: (rowId: string, label: string, isMidi: boolean) => void;
  onFavorite: (isMidi: boolean, rowId: string, current: boolean) => void;
  onDelete: (isMidi: boolean, rowId: string, name: string) => void;
  onContext: (e: React.MouseEvent, payload: SubTabRowPayload) => void;
}>(({ row, isMidi, parentTitle, isPlaying, isBusy, onPlay, onFavorite, onDelete, onContext }) => {
  const rowId = String(row.id ?? '');
  // A per-stem MIDI carries `source: "stem"` for every part; the real
  // instrument lives in the filename, which `midiRowPart` derives (shared with
  // the pickers). A stem row uses its `stem_name` as before.
  const name = isMidi
    ? midiRowPart(row as unknown as LibraryMidiRow)
    : String(row.stem_name ?? 'stem');
  const label = parentTitle ? `${parentTitle} · ${name}` : name;
  const favorite = !!row.favorite;
  const meta = isMidi ? `${row.engine ?? ''}` : `${row.model ?? ''} ${row.model_variant ?? ''}`.trim();
  // A MIDI row drags onto the EDIT timeline carrying its own mime and its midi
  // id (a row in `midis`, not a library entry). A stem row likewise drags with
  // STEM_ID_MIME = its `stems` row id; the editor fetches the stem's audio.
  // Both use a dedicated mime rather than LIBRARY_ID_MIME so a library-entry
  // lookup can never miss the id and die silently.
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(isMidi ? MIDI_ID_MIME : STEM_ID_MIME, rowId);
    e.dataTransfer.setData('text/plain', label);
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div
      className="group flex items-center gap-1 text-[10px] font-mono text-zinc-300 px-1 py-0.5 hover:bg-white/5 rounded"
      draggable
      onDragStart={onDragStart}
      onContextMenu={(e) => onContext(e, isMidi ? { kind: 'midi', midiId: rowId, label } : { kind: 'stem', row })}
      title={
        isMidi
          ? 'Drag onto the timeline — or right-click for piano roll / step sequencer / editor'
          : 'Drag onto the timeline — or right-click for more (send to editor / init / inpaint / chimera)'
      }
    >
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-white/10"
        onClick={() => onFavorite(isMidi, rowId, favorite)}
        title={favorite ? 'Unfavorite' : 'Favorite'}
        aria-label={favorite ? `Unfavorite ${name}` : `Favorite ${name}`}
      >
        <Star className={`w-2.5 h-2.5 ${favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
      </button>
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-white/10"
        disabled={isBusy}
        onClick={() => onPlay(rowId, label, isMidi)}
        title={isPlaying ? 'Pause' : isMidi ? 'Play (synth)' : 'Play'}
        aria-label={isPlaying ? `Pause ${name}` : `Play ${name}`}
      >
        {isBusy ? (
          <Loader2 className="w-2.5 h-2.5 animate-spin text-purple-400" />
        ) : isPlaying ? (
          <Pause className="w-2.5 h-2.5 text-purple-400" />
        ) : (
          <Play className="w-2.5 h-2.5 text-zinc-400 group-hover:text-purple-400" />
        )}
      </button>
      <span className="truncate flex-1 min-w-0">{name}</span>
      <span className="text-[8px] text-zinc-600 ml-1 shrink-0">{meta}</span>
      <button
        type="button"
        className="shrink-0 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => onDelete(isMidi, rowId, name)}
        title="Delete"
        aria-label={`Delete ${name}`}
      >
        <Trash2 className="w-2.5 h-2.5 text-zinc-600 hover:text-red-400" />
      </button>
    </div>
  );
});
SubTabRow.displayName = 'SubTabRow';


const SubTabList: React.FC<SubTabListProps> = ({ byParent, parentTitles, kind, placeholder, onMutated, selectedId, onSelectParent }) => {
  const parentIds = Object.keys(byParent);
  // Shared ContextMenu primitive — fixes drift under .dense-layout
  // zoom and gives consistent close-on-outside behavior across the
  // app (plan step 3d migration).
  const rowMenu = useContextMenu<SubTabRowPayload>();

  // Stems and MIDI are first-class library items: they play through the
  // global engine, can be favorited, and can be deleted independently of
  // their parent track. MIDI playback synthesizes via the shared sawtooth
  // engine in lib/midiSynth (no soundfont needed).
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const [playingRowKey, setPlayingRowKey] = useState<string | null>(null);
  const [busyRowKey, setBusyRowKey] = useState<string | null>(null);
  // Ref mirror so the stable playRow callback can read the current playing row
  // without being recreated each render (which would defeat row memoization).
  const playingRowKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => { playingRowKeyRef.current = playingRowKey; }, [playingRowKey]);

  // Stems / MIDI load with no entryId, so currentEntryId is null while one is
  // playing. If a real track takes over the engine, currentEntryId goes
  // non-null and our rows stop showing the pause state.
  const rowIsPlaying = (rowKey: string) =>
    playingRowKey === rowKey && engineIsPlaying && engineEntryId === null;

  // Stable handlers (read live engine state via getState) so SubTabRow's memo
  // holds across parent re-renders (e.g. opening the context menu).
  const playRow = React.useCallback(async (rowKey: string, label: string, fetchBlob: () => Promise<Blob>) => {
    const ps = usePlayerStore.getState();
    if (playingRowKeyRef.current === rowKey && ps.isPlaying && ps.currentEntryId === null) {
      ps.pause();
      return;
    }
    setBusyRowKey(rowKey);
    try {
      const blob = await fetchBlob();
      await ps.load(blob, { label });
      ps.play();
      setPlayingRowKey(rowKey);
    } catch (e) {
      logError('library', `Could not play ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyRowKey(null);
    }
  }, []);

  const handlePlay = React.useCallback((rowId: string, label: string, isMidi: boolean) => {
    const rowKey = `${isMidi ? 'midi' : 'stem'}:${rowId}`;
    void playRow(
      rowKey,
      label,
      isMidi
        ? async () => {
            const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${rowId}`, { label });
            return (await renderMidiBufferToBlob(buf)).blob;
          }
        : async () => fetchBlobWithRetry(`/api/library/stems/${rowId}/audio`, { label }),
    );
  }, [playRow]);

  const toggleFavorite = React.useCallback(async (isMidi: boolean, rowId: string, current: boolean) => {
    const url = isMidi ? `/api/midi/file/${rowId}` : `/api/library/stems/${rowId}`;
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: !current }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onMutated();
    } catch (e) {
      logError('library', `Could not update favorite: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onMutated]);

  const deleteRow = React.useCallback(async (isMidi: boolean, rowId: string, label: string) => {
    if (!window.confirm(`Delete "${label}"? This removes the file from disk and cannot be undone.`)) return;
    const url = isMidi ? `/api/midi/file/${rowId}` : `/api/library/stems/${rowId}`;
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logInfo('library', `Deleted ${isMidi ? 'MIDI' : 'stem'} "${label}".`);
      await onMutated();
    } catch (e) {
      logError('library', `Could not delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onMutated]);

  if (parentIds.length === 0) {
    return <p className="text-[10px] text-zinc-500 italic py-4 text-center">{placeholder}</p>;
  }

  const payload = rowMenu.payload;
  let menuItems: ContextMenuItem[] = [];
  let menuTitle = '';

  if (payload?.kind === 'midi') {
    const sendable = midiIdToSendable(payload.midiId, payload.label);
    menuTitle = `MIDI · ${payload.label}`;
    menuItems = [
      {
        type: 'item',
        label: 'Send to piano roll',
        icon: <Piano className="w-3 h-3" />,
        onSelect: () => { void sendMidiIdToTarget(payload.midiId, 'piano-roll'); },
      },
      {
        type: 'item',
        label: 'Send to step sequencer',
        icon: <ListOrdered className="w-3 h-3" />,
        onSelect: () => { void sendMidiIdToTarget(payload.midiId, 'step-seq'); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Send to editor (synth)',
        icon: <Layers className="w-3 h-3" />,
        hint: 'new track',
        onSelect: () => { void sendAudioToEditor(sendable, 'editor-new-track'); },
      },
      {
        type: 'item',
        label: 'Send to Init audio (synth)',
        icon: <Wand2 className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInit(sendable); },
      },
      {
        type: 'item',
        label: 'Send to Inpaint (synth)',
        icon: <PenLine className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInpaint(sendable); },
      },
      {
        type: 'item',
        label: 'Add to Chimera (synth)',
        icon: <Music className="w-3 h-3" />,
        onSelect: () => { void sendAudioToChimera([sendable]); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Download .mid',
        icon: <Download className="w-3 h-3" />,
        onSelect: () => {
          // The route serves the file under its stored name, so the dialog offers that name.
          const row = Object.values(byParent).flat().find((r) => String(r.id ?? '') === payload.midiId);
          const stored = basenameOf(String(row?.midi_path ?? ''));
          void saveFile({
            url: `/api/midi/file/${encodeURIComponent(payload.midiId)}`,
            suggestedName: stored || withExt(payload.label, '.mid'),
            kind: 'midi',
          });
        },
      },
      {
        type: 'item',
        label: 'Delete MIDI',
        icon: <Trash2 className="w-3 h-3" />,
        danger: true,
        onSelect: () => { void deleteRow(true, payload.midiId, payload.label); },
      },
    ];
  } else if (payload?.kind === 'stem') {
    const stemId = String(payload.row.id ?? '');
    const stemName = String(payload.row.stem_name ?? 'stem');
    const sendable = stemRowToSendable(payload.row);
    const audioUrl = `/api/library/stems/${stemId}/audio`;
    menuTitle = `Stem · ${stemName}`;
    menuItems = [
      {
        type: 'item',
        label: 'Send to editor (new track)',
        icon: <Layers className="w-3 h-3" />,
        onSelect: () => { void sendAudioToEditor(sendable, 'editor-new-track'); },
      },
      {
        type: 'item',
        label: 'Send to Init audio',
        icon: <Wand2 className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInit(sendable); },
      },
      {
        type: 'item',
        label: 'Send to Inpaint',
        icon: <PenLine className="w-3 h-3" />,
        onSelect: () => { void sendAudioToInpaint(sendable); },
      },
      {
        type: 'item',
        label: 'Add to Chimera',
        icon: <Music className="w-3 h-3" />,
        onSelect: () => { void sendAudioToChimera([sendable]); },
      },
      { type: 'separator' },
      {
        type: 'item',
        label: 'Download .wav',
        icon: <Download className="w-3 h-3" />,
        onSelect: () => {
          void saveFile({
            url: audioUrl,
            suggestedName: withExt(stemName, extOfName(String(payload.row.audio_path ?? '')) || '.wav'),
            kind: 'audio',
          });
        },
      },
      {
        type: 'item',
        label: 'Delete stem',
        icon: <Trash2 className="w-3 h-3" />,
        danger: true,
        onSelect: () => { void deleteRow(false, stemId, stemName); },
      },
    ];
  }

  return (
    <div className="flex flex-col gap-2 relative">
      {parentIds.map((pid) => (
        <div key={pid} data-follow-id={pid} className={groupFrame(pid === selectedId)}>
          <GroupTitle
            title={parentTitles[pid]}
            fallback={pid}
            selected={pid === selectedId}
            tone="text-purple-300"
            onSelect={() => onSelectParent(pid)}
          />
          <div className="flex flex-col gap-0.5">
            {byParent[pid].map((row, idx) => {
              const rowId = String(row.id ?? '');
              const rowKey = `${kind}:${rowId}`;
              return (
                <SubTabRow
                  key={rowId || idx}
                  row={row}
                  isMidi={kind === 'midi'}
                  parentTitle={parentTitles[pid] ?? ''}
                  isPlaying={rowIsPlaying(rowKey)}
                  isBusy={busyRowKey === rowKey}
                  onPlay={handlePlay}
                  onFavorite={toggleFavorite}
                  onDelete={deleteRow}
                  onContext={rowMenu.open}
                />
              );
            })}
          </div>
        </div>
      ))}

      <ContextMenu
        position={rowMenu.position}
        onClose={rowMenu.close}
        items={menuItems}
        title={menuTitle}
      />
    </div>
  );
};


/* ═══════════════════════════════ ScoreList ═══════════════════════════════ */

const SCORE_KIND_LABEL: Record<string, string> = {
  musicxml: 'Sheet',
  alphatex: 'Tab',
  abc: 'ABC',
  pdf: 'PDF',
  svg: 'SVG',
  guitarpro: 'GP',
};

/** SCORE library tab: every sheet / tab / arrangement across the library,
 *  grouped by parent track. A row opens the Score viewer for that track and
 *  downloads the artifact (the backend names the file after the originating
 *  song). Scores are created elsewhere (the bottom Score panel), so a manual
 *  refresh is offered since this list is cached on first open. */
const ScoreList: React.FC<{
  byParent: Record<string, Array<Record<string, unknown>>>;
  parentTitles: Record<string, string>;
  placeholder: string;
  onOpen: (entryId: string) => void;
  onRefresh: () => void | Promise<void>;
  selectedId: string | null;
  onSelectParent: (entryId: string) => void;
}> = ({ byParent, parentTitles, placeholder, onOpen, onRefresh, selectedId, onSelectParent }) => {
  const parentIds = Object.keys(byParent);

  const downloadScore = (id: string, kind: string) => {
    let row: Record<string, unknown> | undefined;
    for (const pid of parentIds) {
      row = byParent[pid].find((r) => String(r.id ?? '') === id);
      if (row) break;
    }
    // The names backend/modules/notation/router.py serves: `<song>_score.zip`
    // for a pack, and the stored file prefixed with `<song>__` for an artifact.
    const slug = songSlug(String(row?.parent_title ?? ''), 'score');
    const stored = basenameOf(String(row?.path ?? ''));
    const artifactName = !stored
      ? `${slug}.${kind}`
      : stored.toLowerCase().startsWith(slug.toLowerCase()) ? stored : `${slug}__${stored}`;
    // Sheets come down as a MusicXML + PDF zip; tabs/others as the raw file.
    void saveFile(
      kind === 'musicxml'
        ? { url: notationPackUrl(id), suggestedName: `${slug}_score.zip` }
        : { url: notationArtifactUrl(id), suggestedName: artifactName },
    );
  };

  const refreshBtn = (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => void onRefresh()}
        className="p-1 rounded text-zinc-500 hover:text-purple-300"
        title="Refresh scores"
        aria-label="Refresh scores"
      >
        <RefreshCw className="w-3 h-3" />
      </button>
    </div>
  );

  if (parentIds.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {refreshBtn}
        <p className="text-[10px] text-zinc-500 italic py-4 text-center">{placeholder}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {refreshBtn}
      {parentIds.map((pid) => (
        <div key={pid} data-follow-id={pid} className={groupFrame(pid === selectedId)}>
          <GroupTitle
            title={parentTitles[pid]}
            fallback={pid}
            selected={pid === selectedId}
            tone="text-emerald-300"
            onSelect={() => onSelectParent(pid)}
          />
          <div className="flex flex-col gap-0.5">
            {byParent[pid].map((row, idx) => {
              const id = String(row.id ?? '');
              const kind = String(row.kind ?? '');
              const label = SCORE_KIND_LABEL[kind] ?? kind.toUpperCase();
              const engine = String(row.engine ?? '');
              return (
                <div
                  key={id || idx}
                  className="group flex items-center gap-1 text-[10px] font-mono text-zinc-300 px-1 py-0.5 hover:bg-white/5 rounded cursor-pointer"
                  onClick={() => onOpen(pid)}
                  title="Open in the Score viewer"
                >
                  <span className="shrink-0 px-1 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[8px] font-black uppercase tracking-widest">
                    {label}
                  </span>
                  <span className="truncate flex-1 min-w-0">{engine || kind}</span>
                  <button
                    type="button"
                    className="shrink-0 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); downloadScore(id, kind); }}
                    title={kind === 'musicxml' ? 'Download MusicXML + PDF' : 'Download score'}
                    aria-label={`Download ${label} score`}
                  >
                    <Download className="w-2.5 h-2.5 text-zinc-500 hover:text-white" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};


