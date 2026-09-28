import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Download, FilePlus2, FileText, Link2, Link2Off, Save, Trash2, X } from 'lucide-react';
import { useLibraryStore } from '../../../state/libraryStore';
import { useLibrarySearch } from '../../../state/useLibrarySearch';
import { useLyricStudioStore } from '../../../state/lyricStudioStore';

/** A key: 28px tall, 12px bold, the theme accent on hover. */
const KEY =
  'h-7 shrink-0 rounded border border-white/10 px-2 flex items-center gap-1.5 text-xs font-bold text-zinc-200 transition-colors hover:border-[rgb(var(--et-accent)/0.5)] hover:bg-[rgb(var(--et-accent)/0.12)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:border-white/10 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]';

/** A key that is open, or the one move that writes. */
const KEY_ON =
  'border-[rgb(var(--et-accent)/0.5)] bg-[rgb(var(--et-accent)/0.15)] et-accent-legend hover:bg-[rgb(var(--et-accent)/0.25)]';

/** An icon-only key; its name travels in aria-label and the tooltip. */
const ICON_KEY = `${KEY} w-7 justify-center px-0`;

/** A group name inside the File panel. */
const GROUP = 'font-display text-xs font-bold uppercase text-zinc-500';

/**
 * The writing column's bar: one File key and the draft's title.
 *
 * Every move on a draft is in the File panel: open another draft, start one,
 * copy it, delete it, and the song half, which picks a song and either imports
 * its words as a new draft or saves these words into it. Attaching is two
 * separate moves on purpose. SAVE writes the words into the entry's lyrics
 * (through /api/lyrics, so SING sees them timed the same way) and IMPORT starts
 * a new draft from words that already exist; neither makes the draft belong to
 * the library, so it stays here and stays editable. The song list is the
 * panel's own search over the whole library, independent of what the LIBRARY
 * tab has loaded.
 *
 * The title field is the one place the draft's name is shown.
 */
export const DocumentRail: React.FC = () => {
  const uid = useId();
  const titleId = `lyric-studio-title-${uid}`;
  const songId = `lyric-studio-song-${uid}`;
  const findId = `lyric-studio-find-${uid}`;
  const panelId = `lyric-studio-file-${uid}`;

  const documents = useLyricStudioStore((s) => s.documents);
  const docId = useLyricStudioStore((s) => s.docId);
  const title = useLyricStudioStore((s) => s.title);
  const attachedId = useLyricStudioStore((s) => s.entryId);
  const error = useLyricStudioStore((s) => s.error);
  const store = useLyricStudioStore.getState;

  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const getById = useLibraryStore((s) => s.getById);
  // Re-render when an entry `getById` had to fetch arrives.
  useLibraryStore((s) => s.lookupVersion);
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const songs = useLibrarySearch({ q: find, kind: 'audio', sort: 'title_asc' }, { enabled: open });
  // The song the song moves act on: whatever this draft is already attached
  // to, else the library selection, else the first song found.
  const [pickedSong, setPickedSong] = useState('');
  const targetId = pickedSong || attachedId || selectedEntryId || songs.rows[0]?.id || '';
  const targetEntry = songs.rows.find((e) => e.id === targetId) ?? (targetId ? getById(targetId) : undefined);
  const target = targetEntry && (targetEntry.kind ?? 'audio') === 'audio' ? targetEntry : null;
  const attachedTitle = attachedId ? getById(attachedId)?.title ?? attachedId : '';

  // Delete asks once, in place: a browser confirm() steals focus from the
  // editor and cannot be styled to say which draft is going.
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      return;
    }
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      keyRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Run a move and close the panel. */
  const act = (move: () => void) => () => {
    move();
    setOpen(false);
  };

  return (
    <div className="shrink-0 min-h-10 border-b border-white/10 bg-white/3 px-3 py-1.5 flex items-center gap-2">
      <div ref={rootRef} className="relative shrink-0">
        <button
          ref={keyRef}
          type="button"
          className={`${KEY} ${open ? KEY_ON : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          title="Drafts: open, new, duplicate, delete, and import from or save to a song"
        >
          <FileText className="size-3.5" aria-hidden="true" />
          File
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>

        {open && (
          <div
            id={panelId}
            role="dialog"
            aria-label="File"
            className="et-opaque absolute left-0 top-full z-40 mt-1 flex w-80 flex-col gap-3 rounded-md border border-white/10 bg-[#0a080f] p-3 text-xs font-bold shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
          >
            <div className="flex flex-col gap-1.5">
              <span className={GROUP}>Drafts</span>
              <div className="flex max-h-48 flex-col overflow-y-auto rounded border border-white/10">
                {documents.length === 0 && <span className="px-2 py-1.5 text-zinc-500">No drafts yet</span>}
                {documents.map((d) => {
                  const current = d.id === docId;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className={`flex h-8 shrink-0 items-center gap-2 border-b border-white/5 px-2 text-left last:border-b-0 hover:bg-[rgb(var(--et-accent)/0.12)] ${
                        current ? 'et-accent-legend' : 'text-zinc-200'
                      }`}
                      onClick={act(() => void store().select(d.id))}
                      aria-current={current ? 'true' : undefined}
                    >
                      <span className="size-3.5 shrink-0">{current && <Check className="size-3.5" aria-hidden="true" />}</span>
                      <span className="min-w-0 flex-1 truncate">{d.title}</span>
                      {d.entry_id && <Link2 className="size-3.5 shrink-0 text-zinc-500" aria-label="attached to a song" />}
                      <span className="shrink-0 tabular-nums text-zinc-500">{d.lines}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" className={KEY} onClick={act(() => void store().createDoc())} title="Start a new blank draft">
                  <FilePlus2 className="size-3.5" aria-hidden="true" /> New
                </button>
                <button
                  type="button"
                  className={KEY}
                  onClick={act(() => docId && void store().duplicateDoc(docId))}
                  disabled={!docId}
                  title="Copy this draft into a new one (unattached), to try a different version"
                >
                  <Copy className="size-3.5" aria-hidden="true" /> Duplicate
                </button>
                {confirming ? (
                  <button
                    type="button"
                    className={`${KEY} ml-auto border-red-500/60 text-red-200 hover:border-red-500/80 hover:bg-red-500/15`}
                    onClick={act(() => docId && void store().removeDoc(docId))}
                    title="Delete this draft for good"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" /> Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${KEY} ml-auto`}
                    onClick={() => setConfirming(true)}
                    disabled={!docId}
                    title="Delete this draft"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" /> Delete
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-white/10 pt-3">
              <label htmlFor={findId} className={GROUP}>Find a song</label>
              <input
                id={findId}
                name={findId}
                type="search"
                className="form-select h-7 px-1.5 text-xs font-bold cursor-text"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="title, artist, bpm, key…"
                spellCheck={false}
              />
              <label htmlFor={songId} className={GROUP}>Song</label>
              <select
                id={songId}
                name={songId}
                className="form-select h-7 px-1.5 text-xs font-bold"
                value={target ? target.id : ''}
                onChange={(e) => setPickedSong(e.target.value)}
                disabled={songs.rows.length === 0 && !target}
              >
                {songs.rows.length === 0 && !target && (
                  <option value="">
                    {songs.loading ? 'searching…' : find.trim() ? 'no song matches' : 'no songs in the library'}
                  </option>
                )}
                {target && !songs.rows.some((e) => e.id === target.id) && (
                  <option value={target.id}>{target.title}</option>
                )}
                {songs.rows.map((e) => (
                  <option key={e.id} value={e.id}>{e.title}</option>
                ))}
              </select>
              {songs.error && <span className="text-red-300">Could not search the library: {songs.error}</span>}
              {songs.hasMore && (
                <button
                  type="button"
                  className={`${KEY} self-start`}
                  onClick={songs.loadMore}
                  disabled={songs.loading}
                  title="List the next songs that match"
                >
                  More songs ({(songs.total - songs.rows.length).toLocaleString()} left)
                </button>
              )}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className={KEY}
                  onClick={act(() => target && void store().importFromEntry(target.id, target.title))}
                  disabled={!target}
                  title="Start a new draft from this song's existing lyrics, leaving the song's own words alone"
                >
                  <Download className="size-3.5" aria-hidden="true" /> Import
                </button>
                <button
                  type="button"
                  className={`${KEY} ${KEY_ON}`}
                  onClick={act(() => target && void store().attachToEntry(target.id))}
                  disabled={!target || !docId}
                  title="Save these words as the song's lyrics (SING and SCORE pick them up) and remember which song this draft became"
                >
                  <Save className="size-3.5" aria-hidden="true" /> Save
                </button>
                {attachedId && (
                  <button
                    type="button"
                    className={`${KEY} ml-auto`}
                    onClick={act(() => void store().detach())}
                    title={`Saved to ${attachedTitle}. Detach: forget which song this draft became; the song keeps the words it was given`}
                  >
                    <Link2Off className="size-3.5" aria-hidden="true" /> Detach
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <label htmlFor={titleId} className="sr-only">Draft title</label>
      <input
        id={titleId}
        name={titleId}
        type="text"
        className="form-select h-7 min-w-0 flex-1 px-2 text-xs font-bold cursor-text"
        value={title}
        onChange={(e) => store().setTitle(e.target.value)}
        placeholder="Untitled"
        spellCheck={false}
      />
      {/* Attached: a link mark, the song's name in its tooltip. */}
      {attachedId && (
        <Link2
          className="size-4 shrink-0 text-[rgb(var(--et-accent))]"
          role="img"
          aria-label={`Saved to ${attachedTitle}`}
        >
          <title>{`Saved to ${attachedTitle}`}</title>
        </Link2>
      )}
      {error && (
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-red-300">
          <span className="truncate" title={error}>{error}</span>
          <button
            type="button"
            className={ICON_KEY}
            onClick={() => store().clearError()}
            aria-label="Dismiss the error"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  );
};

export default DocumentRail;
