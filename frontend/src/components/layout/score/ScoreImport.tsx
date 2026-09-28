/**
 * The SCORE rail's way to bring in a score that is not made from a track:
 *
 *  - IMPORT SCORE FILE opens the file picker for .musicxml, .xml, .mxl, .krn
 *    and .abc and posts the file to /api/notation/import;
 *  - BROWSE CORPUS opens a dialog that searches the music21 corpus (Bach
 *    chorales, Palestrina, Monteverdi, the Classical quartets, folk-tune
 *    books) and imports the chosen piece through /api/notation/corpus/open.
 *
 * Either one makes a composition entry of its own (library kind 'score') and
 * hands the answer to `onImported`; ScoreView selects it, which lists the new
 * sheet in the rail and opens it, and the library counts are invalidated so
 * the Library's SCORE list fetches it too (see announceImportedScore).
 *
 * The results list is a listbox the arrow keys drive from the search field
 * (aria-activedescendant), so focus never leaves the field while choosing;
 * Enter opens the active piece.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileUp, Library, Loader2, X } from 'lucide-react';
import {
  importScoreFile,
  openCorpusPiece,
  searchCorpus,
  type CorpusPiece,
  type NotationCapabilities,
  type ScoreImportResult,
} from '../../../lib/notationClient';
import { useLibraryStore } from '../../../state/libraryStore';
import { useLibraryCounts } from '../../../state/libraryCountsStore';
import { logError, logInfo } from '../../../state/logStore';
import {
  acceptAttribute,
  CORPUS_SEARCH_DEBOUNCE_MS,
  corpusQuery,
  corpusRow,
  importRefusal,
  nextActiveIndex,
  resultsSummary,
} from './scoreImportModel';

/**
 * Make an imported composition known to every surface that lists scores:
 * the library store fetches the entry (it is not on an audio page) and
 * selects it, which is what SCORE and the Library's INFO read; the counts
 * are invalidated, which is the notation commit path the Library's SCORE
 * list refreshes on.
 */
export async function announceImportedScore(result: ScoreImportResult): Promise<void> {
  const library = useLibraryStore.getState();
  await library.ensureEntry(result.entry_id);
  library.setSelectedEntry(result.entry_id);
  useLibraryCounts.getState().invalidate();
  logInfo(
    'score',
    `Imported ${result.title}${result.composer ? ` by ${result.composer}` : ''} as a composition`,
  );
}

const RAIL_BUTTON =
  'h-8 min-w-0 flex-1 flex items-center justify-center gap-1.5 rounded border border-white/10 px-2 text-xs font-bold text-zinc-300 transition-colors hover:border-[rgb(var(--et-accent)/0.5)] hover:text-zinc-100 disabled:opacity-40 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]';

const DIALOG_BUTTON =
  'h-8 px-3 flex items-center gap-2 rounded-xs text-xs font-bold uppercase tracking-wider bg-white/10 text-zinc-100 disabled:opacity-40 hover:bg-white/15 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]';

export interface ScoreImportProps {
  caps: NotationCapabilities | null;
  /** Called with the new composition once it is made. */
  onImported: (result: ScoreImportResult) => void | Promise<void>;
}

export const ScoreImport: React.FC<ScoreImportProps> = ({ caps, onImported }) => {
  const uid = useId();
  const fileInputId = `score-import-file-${uid}`;
  const dialogId = `score-corpus-dialog-${uid}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const browseRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [corpusOpen, setCorpusOpen] = useState(false);
  const corpusAvailable = caps?.score_import?.corpus !== false;

  const importFile = async (file: File) => {
    const refusal = importRefusal(file, caps);
    if (refusal) {
      setStatus(refusal);
      logError('score', refusal);
      return;
    }
    setBusy(true);
    setStatus(`Importing ${file.name}…`);
    try {
      const result = await importScoreFile(file);
      setStatus(`Imported ${result.title}.`);
      await onImported(result);
    } catch (e) {
      const message = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
      setStatus(message);
      logError('score', message);
    } finally {
      setBusy(false);
    }
  };

  const closeCorpus = useCallback(() => {
    setCorpusOpen(false);
    browseRef.current?.focus();
  }, []);

  const onCorpusImported = async (result: ScoreImportResult) => {
    setStatus(`Imported ${result.title}.`);
    closeCorpus();
    await onImported(result);
  };

  return (
    <div className="shrink-0 border-b border-white/10 px-3 py-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={RAIL_BUTTON}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          title="Import a score file (.musicxml, .xml, .mxl, .krn or .abc) as a composition of its own"
        >
          {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : <FileUp className="size-3.5 shrink-0" aria-hidden="true" />}
          <span className="truncate">Import score file</span>
        </button>
        <button
          type="button"
          ref={browseRef}
          className={RAIL_BUTTON}
          onClick={() => setCorpusOpen(true)}
          disabled={busy || !corpusAvailable}
          aria-haspopup="dialog"
          aria-expanded={corpusOpen}
          aria-controls={corpusOpen ? dialogId : undefined}
          title={corpusAvailable ? 'Search the music21 corpus and open a piece as a composition' : 'The music21 corpus is not available on this backend'}
        >
          <Library className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Browse corpus</span>
        </button>
      </div>
      <label htmlFor={fileInputId} className="sr-only">Score file to import</label>
      <input
        ref={inputRef}
        id={fileInputId}
        name="score-import-file"
        type="file"
        accept={acceptAttribute(caps)}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again still fires a change.
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
      <p role="status" className="text-xs font-semibold text-zinc-400 empty:hidden">{status}</p>
      {corpusOpen && (
        <CorpusDialog id={dialogId} onClose={closeCorpus} onImported={(result) => void onCorpusImported(result)} />
      )}
    </div>
  );
};

interface CorpusDialogProps {
  id: string;
  onClose: () => void;
  onImported: (result: ScoreImportResult) => void;
}

export const CorpusDialog: React.FC<CorpusDialogProps> = ({ id, onClose, onImported }) => {
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    search: `score-corpus-search-${uid}`,
    listLabel: `${uid}-list-label`,
    list: `${uid}-list`,
    summary: `${uid}-summary`,
  };
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState<CorpusPiece[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const query = corpusQuery(text);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!query) {
      setResults([]);
      setTotal(0);
      setActive(-1);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchCorpus(query, ctrl.signal)
        .then((answer) => {
          setResults(answer.results);
          setTotal(answer.total);
          setActive(answer.results.length > 0 ? 0 : -1);
          setError('');
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setResults([]);
          setTotal(0);
          setError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, CORPUS_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // The active option stays in view as the arrow keys move it.
  useEffect(() => {
    if (active < 0) return;
    const option = dialogRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const chosen = active >= 0 ? results[active] ?? null : null;

  const openChosen = async (piece: CorpusPiece | null = chosen) => {
    if (!piece || opening) return;
    setOpening(true);
    setError('');
    try {
      const result = await openCorpusPiece(piece.id);
      onImported(result);
    } catch (e) {
      const message = `Could not open ${piece.title || piece.id}: ${e instanceof Error ? e.message : String(e)}`;
      setError(message);
      logError('score', message);
    } finally {
      setOpening(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Every key stops at the dialog, so the app's window hotkeys never act
    // behind it.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const fromList = e.target === searchRef.current || (e.target as HTMLElement).getAttribute?.('role') === 'listbox';
    if (fromList) {
      const next = nextActiveIndex(e.key, active, results.length);
      if (next !== null) {
        e.preventDefault();
        setActive(next);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void openChosen();
        return;
      }
    }
    if (e.key === 'Tab') {
      const box = dialogRef.current;
      const focusables = box
        ? Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled]), input, [role="listbox"]'))
        : [];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const activeId = chosen ? `${ids.list}-${active}` : undefined;
  const summary = error || resultsSummary(query, total, results.length, loading);

  const dialog = (
    <div className="fixed inset-0 z-200 flex items-center justify-center p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.heading}
        aria-describedby={ids.summary}
        onKeyDown={onKeyDown}
        className="relative w-160 max-w-full max-h-[85vh] flex flex-col rounded-sm border border-white/10 bg-[#0a080f] text-zinc-200 shadow-[0_8px_32px_rgba(0,0,0,0.75)]"
      >
        <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/10">
          <Library aria-hidden="true" className="size-4 shrink-0 text-zinc-400" />
          <h2 id={ids.heading} className="flex-1 min-w-0 truncate font-display text-sm font-bold uppercase tracking-wider">
            Browse corpus
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the corpus browser"
            title="Close"
            className="size-8 flex items-center justify-center rounded-xs text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="px-4 pt-3 flex flex-col gap-1">
          <label htmlFor={ids.search} className="text-xs font-bold text-zinc-300">
            Search the music21 corpus by composer, title or file
          </label>
          <input
            ref={searchRef}
            id={ids.search}
            name="score-corpus-search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={ids.list}
            aria-activedescendant={activeId}
            placeholder="bach, palestrina, bwv66.6…"
            className="h-9 rounded-xs border border-white/15 bg-black/40 px-2 text-sm font-semibold text-zinc-100 placeholder:text-zinc-500 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]"
          />
        </div>

        <div className="px-4 pt-2 flex items-center gap-2">
          <span id={ids.listLabel} className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400">
            Pieces
          </span>
          <span id={ids.summary} role="status" className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-400">
            {summary}
          </span>
          {loading && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-zinc-400" />}
        </div>

        <div
          id={ids.list}
          role="listbox"
          aria-labelledby={ids.listLabel}
          aria-activedescendant={activeId}
          tabIndex={0}
          className="mx-4 mt-1 min-h-40 flex-1 overflow-y-auto rounded-xs border border-white/10 bg-black/30 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]"
        >
          {results.map((piece, index) => {
            const row = corpusRow(piece);
            const selected = index === active;
            return (
              <div
                key={piece.id}
                id={`${ids.list}-${index}`}
                data-index={index}
                role="option"
                aria-selected={selected}
                title={row.label}
                onClick={() => setActive(index)}
                onDoubleClick={() => void openChosen(piece)}
                className={`cursor-pointer px-2.5 py-1.5 border-b border-white/5 ${
                  selected ? 'bg-[rgb(var(--et-accent)/0.18)] text-zinc-50' : 'text-zinc-300 hover:bg-white/5'
                }`}
              >
                <div className="truncate text-sm font-bold">{row.primary}</div>
                <div className="truncate text-xs font-semibold text-zinc-400">{row.secondary}</div>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 mt-2 border-t border-white/10 flex items-center justify-end gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-400" title={chosen?.path}>
            {chosen ? chosen.path : 'No piece chosen'}
          </span>
          <button type="button" onClick={onClose} className={DIALOG_BUTTON}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void openChosen()}
            disabled={!chosen || opening}
            className={`${DIALOG_BUTTON} text-[rgb(var(--et-accent))]`}
            title={chosen ? `Open ${corpusRow(chosen).primary} as a composition` : 'Choose a piece first'}
          >
            {opening && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
            Open
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
};

export default ScoreImport;
