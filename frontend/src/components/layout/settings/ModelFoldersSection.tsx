/**
 * Settings → Model folders: manage `settings.models.extra_folders` — the extra
 * directories theDAW scans for local model checkpoints, on top of its built-in
 * locations.
 *
 * Unlimited rows. Add a path (browse or paste) with the input + Add (Enter
 * works too); remove any row. Every change PATCHes the whole list wholesale and
 * takes the backend's returned list as the new truth (via the feature-toggle
 * store), so a failed save rolls back visibly and raises the shared notice.
 *
 * Tolerant of `models.extra_folders` being absent from the server payload
 * (older backend): the store defaults it to [], so this reads [] and still
 * lets you add the first folder.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FolderSearch, Loader2, Plus, Trash2 } from 'lucide-react';
import { useFeatureToggleStore } from '../../../state/featureToggleStore';
import { PathInput } from '../../ui/PathInput';
import { BTN_PURPLE, BTN_ROSE, CARD, SectionHeader } from './shared';

export const ModelFoldersSection: React.FC = () => {
  const folders = useFeatureToggleStore((s) => s.settings.models?.extra_folders ?? []);
  const patch = useFeatureToggleStore((s) => s.patch);

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // Local, non-persisted hints for the two client-side rejections (empty is
  // simply ignored). Cleared as soon as the field changes.
  const [hint, setHint] = useState<string | null>(null);

  // The "Saved" chip's timer, cleared on unmount so closing the modal
  // mid-window cannot setState on an unmounted component.
  const savedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (savedTimer.current !== null) window.clearTimeout(savedTimer.current); }, []);

  // Save a full list; take the server's echoed list as truth via the store.
  // Returns whether the backend confirmed it.
  const commit = async (next: string[]): Promise<boolean> => {
    setSaving(true);
    setJustSaved(false);
    const ok = await patch({ models: { extra_folders: next } });
    setSaving(false);
    if (ok) {
      setJustSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => { savedTimer.current = null; setJustSaved(false); }, 1600);
    }
    return ok;
  };

  const onAdd = async () => {
    // One PATCH at a time: Enter can fire while a save is still in flight, and
    // two overlapping writes let an earlier server echo land last.
    if (saving) return;
    const path = draft.trim();
    if (!path) return; // ignore empty
    if (folders.includes(path)) {
      setHint('Already in the list');
      return;
    }
    setHint(null);
    const ok = await commit([...folders, path]);
    if (ok) setDraft('');
  };

  const onRemove = (path: string) => {
    void commit(folders.filter((f) => f !== path));
  };

  return (
    <section aria-labelledby="settings-model-folders-title">
      <SectionHeader
        icon={<FolderSearch className="w-3.5 h-3.5 text-purple-400" />}
        title="Model folders"
        tip="Extra folders theDAW scans for local model checkpoints, in addition to its built-in locations. Add as many as you like — absolute or project-relative paths. Removing a row only stops scanning that folder; nothing on disk is touched."
      >
        {saving && (
          <span className="flex items-center gap-1 text-[11px] font-mono uppercase tracking-widest text-zinc-400">
            <Loader2 className="w-3 h-3 animate-spin" /> Saving…
          </span>
        )}
        {!saving && justSaved && (
          <span className="text-[11px] font-mono uppercase tracking-widest text-emerald-400">Saved</span>
        )}
      </SectionHeader>
      <span id="settings-model-folders-title" className="sr-only">Model folders</span>

      {/* Add a folder: browse or paste, Enter or the Add button commits. */}
      <div className="flex items-end gap-1.5">
        <PathInput
          inline
          id="settings-model-folder-path"
          name="settings-model-folder-path"
          label="Folder"
          value={draft}
          onChange={(v) => { setDraft(v); if (hint) setHint(null); }}
          kind="folder"
          disabled={saving}
          onEnter={() => void onAdd()}
          placeholder="D:\models\checkpoints"
          description="Browse or paste a folder path. theDAW scans it for model checkpoints in addition to its built-in locations."
          className="flex-1"
        />
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={saving || !draft.trim()}
          className={BTN_PURPLE}
          title="Add this folder to the scan list"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {/* Live region is always in the DOM — a role="status" inserted together
          with its text is frequently not announced. Empty when there is no hint. */}
      <p role="status" className="mt-1 text-[11px] font-mono text-amber-300 empty:mt-0">{hint}</p>

      {/* The list — one row each, unlimited. */}
      {folders.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {folders.map((folder) => (
            <div key={folder} className={`flex items-center gap-2 px-2 py-1 ${CARD}`}>
              <span className="text-[11px] font-mono text-zinc-300 truncate flex-1 min-w-0" title={folder}>{folder}</span>
              <button
                type="button"
                onClick={() => onRemove(folder)}
                disabled={saving}
                className={BTN_ROSE}
                aria-label={`Remove ${folder} from the scan list`}
                title="Stop scanning this folder (nothing on disk is touched)"
              >
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] font-mono text-zinc-500">No extra folders yet — theDAW scans its built-in locations only.</p>
      )}
    </section>
  );
};
