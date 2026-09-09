import React, { useId, useState } from 'react';
import { Copy, Download, FilePlus2, Link2, Link2Off, Save, Trash2 } from 'lucide-react';
import { useLibraryStore } from '../../../state/libraryStore';
import { useLyricStudioStore } from '../../../state/lyricStudioStore';

const BTN = 'btn-ghost text-[9px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40';

/**
 * The notebook's header: which draft is open, what it is called, and the song
 * it can become.
 *
 * Attaching is deliberately two separate moves — SAVE TO SONG writes the words
 * into the entry's lyrics (through /api/lyrics, so SING sees them timed the
 * same way), IMPORT FROM SONG starts a new draft from words that already
 * exist. Neither one makes the notebook page belong to the library: the draft
 * stays here and stays editable.
 */
export const DocumentRail: React.FC = () => {
  const uid = useId();
  const docSelectId = `lyric-studio-doc-${uid}`;
  const titleId = `lyric-studio-title-${uid}`;
  const songId = `lyric-studio-song-${uid}`;

  const documents = useLyricStudioStore((s) => s.documents);
  const docId = useLyricStudioStore((s) => s.docId);
  const title = useLyricStudioStore((s) => s.title);
  const attachedId = useLyricStudioStore((s) => s.entryId);
  const error = useLyricStudioStore((s) => s.error);
  const store = useLyricStudioStore.getState;

  const entries = useLibraryStore((s) => s.entries);
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const songs = entries.filter((e) => !e.kind || e.kind === 'audio');
  // The song the attach controls act on: whatever this draft is already
  // attached to, else the library selection, else the first song.
  const [pickedSong, setPickedSong] = useState('');
  const targetId = pickedSong || attachedId || selectedEntryId || songs[0]?.id || '';
  const target = songs.find((e) => e.id === targetId) ?? null;

  // Delete asks once, in place: a browser confirm() steals focus from the
  // editor and cannot be styled to say which draft is going.
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="shrink-0 border-b border-white/5 bg-black/30">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 font-mono text-[9px]">
        <label htmlFor={docSelectId} className="text-zinc-500 select-none">DRAFT</label>
        <select
          id={docSelectId}
          name={docSelectId}
          className="form-select text-[9px] px-1 py-0.5 min-w-40 max-w-64"
          value={docId ?? ''}
          onChange={(e) => void store().select(e.target.value)}
        >
          {!docId && <option value="">—</option>}
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} · {d.lines} lines{d.entry_id ? ' · attached' : ''}
            </option>
          ))}
        </select>

        <label htmlFor={titleId} className="text-zinc-500 select-none">TITLE</label>
        <input
          id={titleId}
          name={titleId}
          type="text"
          className="form-select text-[9px] px-1 py-0.5 min-w-40"
          value={title}
          onChange={(e) => store().setTitle(e.target.value)}
          placeholder="Untitled"
          spellCheck={false}
        />

        <button type="button" className={BTN} onClick={() => void store().createDoc()} title="Start a new blank draft">
          <FilePlus2 className="w-3 h-3" /> NEW
        </button>
        <button
          type="button"
          className={BTN}
          onClick={() => docId && void store().duplicateDoc(docId)}
          disabled={!docId}
          title="Copy this draft into a new one (unattached), to try a different version"
        >
          <Copy className="w-3 h-3" /> DUPLICATE
        </button>
        {confirming ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className={`${BTN} border border-rose-500/50 text-rose-200`}
              onClick={() => {
                setConfirming(false);
                if (docId) void store().removeDoc(docId);
              }}
              title="Delete this draft for good"
            >
              <Trash2 className="w-3 h-3" /> DELETE FOR GOOD
            </button>
            <button type="button" className={BTN} onClick={() => setConfirming(false)}>
              KEEP
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={BTN}
            onClick={() => setConfirming(true)}
            disabled={!docId}
            title="Delete this draft"
          >
            <Trash2 className="w-3 h-3" /> DELETE
          </button>
        )}
      </div>

      {/* The song half: import words from one, or save these into one. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/5 px-2 py-1 font-mono text-[9px]">
        <label htmlFor={songId} className="text-zinc-500 select-none">SONG</label>
        <select
          id={songId}
          name={songId}
          className="form-select text-[9px] px-1 py-0.5 min-w-48 max-w-72"
          value={targetId}
          onChange={(e) => setPickedSong(e.target.value)}
          disabled={songs.length === 0}
        >
          {songs.length === 0 && <option value="">no songs in the library</option>}
          {songs.map((e) => (
            <option key={e.id} value={e.id}>{e.title}</option>
          ))}
        </select>
        <button
          type="button"
          className={BTN}
          onClick={() => target && void store().importFromEntry(target.id, target.title)}
          disabled={!target}
          title="Start a new draft from this song's existing lyrics, leaving the song's own words alone"
        >
          <Download className="w-3 h-3" /> IMPORT FROM SONG
        </button>
        <button
          type="button"
          className={`${BTN} border border-rose-500/40 text-rose-200`}
          onClick={() => target && void store().attachToEntry(target.id)}
          disabled={!target || !docId}
          title="Save these words as the song's lyrics (SING and SCORE pick them up) and remember which song this draft became"
        >
          <Save className="w-3 h-3" /> SAVE TO SONG
        </button>
        {attachedId ? (
          <span className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 text-emerald-200">
            <Link2 className="w-3 h-3" />
            {entries.find((e) => e.id === attachedId)?.title ?? attachedId}
            <button
              type="button"
              className="btn-ghost text-[8px] py-0 px-1"
              onClick={() => void store().detach()}
              title="Forget which song this draft became; the song keeps the words it was given"
              aria-label="Detach this draft from its song"
            >
              <Link2Off className="w-3 h-3" />
            </button>
          </span>
        ) : (
          <span className="text-zinc-600">attached to no song</span>
        )}
        {error && (
          <span className="ml-auto flex items-center gap-1 text-rose-300">
            {error}
            <button
              type="button"
              className="btn-ghost text-[8px] py-0 px-1"
              onClick={() => store().clearError()}
              aria-label="Dismiss the error"
            >
              ×
            </button>
          </span>
        )}
      </div>
    </div>
  );
};

export default DocumentRail;
