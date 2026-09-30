/**
 * Title, tags and notes of a library entry. Opened from the footer track
 * menu's "Title, tags and notes" row. It portals into the menu's theme host, so
 * it takes the app theme.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { LibraryEntry } from '../../state/libraryEntry';
import { useLibraryStore } from '../../state/libraryStore';
import { useLibraryCounts } from '../../state/libraryCountsStore';
import { getStorageProvider } from '../../lib/backendLocalProvider';
import { logError, logInfo } from '../../state/logStore';
import { FLYOUT_CARD } from './midiDockKit';

interface TrackMetaDialogProps {
  entry: LibraryEntry;
  /** The full-viewport theme host the footer track menu portals into. */
  host: HTMLElement;
  onClose: () => void;
}

const LABEL = 'font-display text-xs font-bold uppercase tracking-wider et-ink-2';
const FIELD = 'w-full rounded-xs border border-white/10 bg-black/40 px-2 py-1.5 text-sm font-semibold et-ink';
const BUTTON =
  'h-8 px-3 rounded-xs text-xs font-bold uppercase tracking-wider bg-white/10 et-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.1)] disabled:*:opacity-40';

const parseTags = (text: string): string[] =>
  Array.from(new Set(text.split(',').map((t) => t.trim()).filter(Boolean)));

export const TrackMetaDialog: React.FC<TrackMetaDialogProps> = ({ entry, host, onClose }) => {
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    title: `${uid}-title`,
    tags: `${uid}-tags`,
    notes: `${uid}-notes`,
    error: `${uid}-error`,
  };
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState(entry.title);
  const [tags, setTags] = useState(entry.tags.join(', '));
  const [notes, setNotes] = useState(entry.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
    firstRef.current?.select();
  }, []);

  // Escape closes; Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const box = dialogRef.current;
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(
        box.querySelectorAll<HTMLElement>('input, textarea, button:not([disabled])'),
      );
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
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const nextTitle = title.trim() || entry.title;
    try {
      // The provider directly: libraryStore.updateEntry logs a failed save and
      // resolves, and the dialog has to stay open on a save that did not land.
      const updated = await getStorageProvider().update(entry.id, { title: nextTitle, tags: parseTags(tags), notes });
      // …but the RESULT goes back through the store, never through a raw
      // `setState({entries})`: `entries` is a projection of the paged cache and
      // the next page that lands re-derives it, so a row written straight into
      // it was lost on the next scroll. `upsertEntry` patches the row wherever
      // it is cached (page, by-id cache, or the whole-library fallback) and, for
      // a row on no loaded page, re-reads the visible range — which is also the
      // right answer when a renamed track moves under a title sort.
      useLibraryStore.getState().upsertEntry(updated);
      // A committed write bumps `library_revision`; the counts the tab strip
      // prints are derived from it, so they are asked for again.
      useLibraryCounts.getState().invalidate();
      logInfo('track-menu', `Saved the details of "${nextTitle}"`);
      onClose();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      logError('track-menu', `Saving the details of "${nextTitle}" failed: ${text}`);
      setError(`Not saved: ${text}`);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-10 flex items-center justify-center p-4 bg-black/60 pointer-events-auto">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.heading}
        aria-describedby={error ? ids.error : undefined}
        // Keys stop at the dialog: EDIT's window hotkeys (Delete removes clips)
        // would act behind it. Escape and Tab are handled above, in capture.
        onKeyDown={(e) => e.stopPropagation()}
        className={`${FLYOUT_CARD} w-full max-w-md flex flex-col gap-3 p-4`}
      >
        <div className="flex items-center gap-2">
          <h2 id={ids.heading} className="flex-1 min-w-0 truncate font-display text-sm font-bold uppercase tracking-wider et-ink">
            Title, tags and notes
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="h-8 w-8 flex items-center justify-center rounded-xs et-ink-2 hover:et-ink">
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.title} className={LABEL}>Title</label>
            <input ref={firstRef} id={ids.title} name="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.tags} className={LABEL}>Tags, comma separated</label>
            <input id={ids.tags} name="tags" type="text" value={tags} onChange={(e) => setTags(e.target.value)} className={FIELD} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.notes} className={LABEL}>Notes</label>
            <textarea id={ids.notes} name="notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} className={`${FIELD} resize-y`} />
          </div>
          {error && (
            <p id={ids.error} role="alert" className="text-xs font-semibold et-ink">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={BUTTON}><span>Cancel</span></button>
            <button type="submit" disabled={saving} className={`${BUTTON} text-[rgb(var(--et-accent))]`}>
              <span>{saving ? 'Saving' : 'Save'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>,
    host,
  );
};
