/**
 * Storage: every model/data location on one line each (label · path · size ·
 * Open), the Hugging Face cache as an expandable row, and the VJ export folder.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, HardDrive, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { getJson, postJson } from '../../../lib/apiJson';
import { fetchHfCache, fetchLocations, formatBytes, openLocation, type HfRepo, type StorageLocation } from '../../../lib/storageClient';
import { useFeatureToggleStore } from '../../../state/featureToggleStore';
import { PathInput } from '../../ui/PathInput';
import { BTN_GHOST, BTN_PURPLE, BTN_ROSE, CARD, SectionHeader } from './shared';

export const MEDIA_ROOTS_EMPTY =
  'No media roots yet — entries with no file of their own stay unplayable.';
/** Shown when the backend redacted the list: this device cannot see or set it. */
export const MEDIA_ROOTS_HIDDEN =
  'Hidden on this device — manage media roots on the theDAW PC.';

/** What an empty media-root list says. Empty means two different things: the
 *  backend blanks the list for a caller that may not set it (a phone on the
 *  LAN -- settings/router.py `_redacted_for`), and telling that user "none
 *  yet" would be a lie about the PC's library, plus an invitation to add one
 *  the PATCH guard then refuses. A function so the branch can be tested
 *  without a DOM: zustand answers a server render from its INITIAL state, so
 *  `renderToString` cannot see a seeded store. */
export const mediaRootsEmptyText = (redacted: boolean): string =>
  redacted ? MEDIA_ROOTS_HIDDEN : MEDIA_ROOTS_EMPTY;

const MEDIA_ROOTS_TIP =
  "Folders holding your own copies of library media, named after the entry they belong to \u2014 the full id, or the [xxxxxxxx] short tag before the extension. An entry with no file of its own is served from here instead of from the internet. Nothing is copied or moved: the file is played where it sits. The environment variable theDAW_MEDIA_ROOTS overrides this list when it is set.";

/** What `GET /api/library/media-roots` reports about the index. */
interface MediaRootIndexStatus {
  roots: string[];
  ready: boolean;
  scanning: boolean;
  files: number;
  short_ids: number;
  age_seconds: number | null;
  /** Why the last walk produced no index, or null. A failed scan and a scan
   *  that never started both report ready:false; only this tells them apart. */
  error: string | null;
}

const describeIndex = (status: MediaRootIndexStatus | null): string => {
  if (!status) return 'Index status unavailable.';
  if (status.scanning) return 'Scanning\u2026 the library falls back to its old behaviour until this lands.';
  if (status.error) return `Last scan failed: ${status.error}`;
  if (!status.ready) return 'Not indexed yet.';
  const age = status.age_seconds == null ? '' : ` \u00b7 ${Math.round(status.age_seconds)}s ago`;
  return `${status.files.toLocaleString()} file(s) indexed${age}`;
};

/**
 * Settings \u2192 Storage \u2192 Media roots: the folder list the library resolves an
 * entry's file from before it asks anything remote, plus the index's own state
 * and a Rescan button.
 *
 * The list is PATCHed wholesale (the backend assigns the key wholesale) and the
 * store's echoed value is the new truth, so a rejected save rolls back visibly
 * \u2014 the same contract Model folders uses.
 */
export const MediaRootsRows: React.FC = () => {
  const roots = useFeatureToggleStore((s) => s.settings.library?.media_roots ?? []);
  // The backend blanks the list for a caller that may not set it, so an empty
  // list here can mean two different things. Saying "none yet" to someone on a
  // phone would be a lie about the PC's library.
  const redacted = useFeatureToggleStore((s) => s.settings.library?.media_roots_redacted === true);
  const patch = useFeatureToggleStore((s) => s.patch);

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<MediaRootIndexStatus | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const loadStatus = React.useCallback(async () => {
    try {
      setStatus(await getJson<MediaRootIndexStatus>('/api/library/media-roots'));
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // A scan of a few hundred thousand files takes minutes, so while one is
  // running the status is re-read on a timer rather than left stale until the
  // user reopens Settings.
  useEffect(() => {
    if (!status?.scanning) return;
    const id = window.setInterval(() => { void loadStatus(); }, 2000);
    return () => window.clearInterval(id);
  }, [status?.scanning, loadStatus]);

  const commit = async (next: string[]): Promise<boolean> => {
    setSaving(true);
    const ok = await patch({ library: { media_roots: next } });
    setSaving(false);
    return ok;
  };

  const onAdd = async () => {
    if (saving) return;
    const path = draft.trim();
    if (!path) return;
    if (roots.includes(path)) {
      setHint('Already in the list');
      return;
    }
    setHint(null);
    if (await commit([...roots, path])) setDraft('');
  };

  const onRescan = async () => {
    setRescanning(true);
    try {
      setStatus(await postJson<MediaRootIndexStatus>('/api/library/media-roots/rescan'));
    } catch {
      /* the status line already says what is known */
    } finally {
      setRescanning(false);
      void loadStatus();
    }
  };

  return (
    <div className={`${CARD} px-2 py-1 flex flex-col gap-1`}>
      <div className="flex items-center gap-2">
        <span id="settings-media-roots-label" title={MEDIA_ROOTS_TIP} className="text-[9px] font-mono uppercase tracking-wider text-zinc-400 shrink-0 cursor-help">
          Media roots
        </span>
        <span className="text-[10px] font-mono text-zinc-500 truncate flex-1 min-w-0">{describeIndex(status)}</span>
        <button
          type="button"
          onClick={() => void onRescan()}
          disabled={rescanning || status?.scanning === true}
          className={BTN_GHOST}
          title="Walk every media root again and rebuild the index"
        >
          {rescanning || status?.scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Rescan
        </button>
      </div>

      <div className="flex items-end gap-1.5">
        <PathInput
          inline
          id="settings-media-root-path"
          name="settings-media-root-path"
          label="Folder"
          value={draft}
          onChange={(v) => { setDraft(v); if (hint) setHint(null); }}
          kind="folder"
          disabled={saving}
          onEnter={() => void onAdd()}
          placeholder="D:\\music"
          description={MEDIA_ROOTS_TIP}
          className="flex-1"
        />
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={saving || !draft.trim()}
          className={BTN_PURPLE}
          title="Add this folder to the media roots"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      <p role="status" className="text-[11px] font-mono text-amber-300 empty:hidden">{hint}</p>

      {roots.length > 0 ? (
        <div className="flex flex-col gap-1">
          {roots.map((folder) => (
            <div key={folder} className="flex items-center gap-2 px-1.5 py-0.5 rounded border border-white/5">
              <span className="text-[11px] font-mono text-zinc-300 truncate flex-1 min-w-0" title={folder}>{folder}</span>
              <button
                type="button"
                onClick={() => { void commit(roots.filter((f) => f !== folder)); }}
                disabled={saving}
                className={BTN_ROSE}
                aria-label={`Remove ${folder} from the media roots`}
                title="Stop resolving entries from this folder (nothing on disk is touched)"
              >
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] font-mono text-zinc-500">{mediaRootsEmptyText(redacted)}</p>
      )}
    </div>
  );
};

const VJ_FOLDER_TIP =
  'Where VJ recordings are saved. A relative path sits inside the project; Browse fills an absolute folder such as D:\\Renders. Each take adds its record-bar subfolder, then ffmpeg transcodes to the chosen codec.';

/** Hover detail for a location's size: every model in the directory. */
const locationInventoryTitle = (loc: StorageLocation): string | undefined => {
  const models = loc.models ?? [];
  if (!models.length) return loc.files != null ? `${loc.files} files` : undefined;
  const lines = models.slice(0, 14).map((m) =>
    `${m.recommended ? '★ ' : ''}${m.name} — ${formatBytes(m.bytes)}\n    ${m.path}${m.note ? `\n    ${m.note}` : ''}`);
  if (models.length > 14) lines.push(`…and ${models.length - 14} more`);
  return lines.join('\n');
};

export const StorageSection: React.FC = () => {
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [hfRepos, setHfRepos] = useState<HfRepo[]>([]);
  const [hfTotal, setHfTotal] = useState(0);
  const [hfOpen, setHfOpen] = useState(false);
  const [sizesLoading, setSizesLoading] = useState(false);

  const load = React.useCallback((refresh = false) => {
    setSizesLoading(true);
    fetchLocations(refresh).then(setLocations).catch(() => setLocations([])).finally(() => setSizesLoading(false));
    fetchHfCache().then((d) => { setHfRepos(d.repos); setHfTotal(d.total_bytes); }).catch(() => setHfRepos([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  // VJ export root: mirrored locally so typing doesn't PATCH per keystroke;
  // committed on blur / Enter.
  const exportRoot = useFeatureToggleStore((s) => s.settings.vj?.export_root ?? 'exports/vj');
  const patchFeatures = useFeatureToggleStore((s) => s.patch);
  const refreshFeatures = useFeatureToggleStore((s) => s.refresh);
  const [vjExportRoot, setVjExportRoot] = useState(exportRoot);
  useEffect(() => { setVjExportRoot(exportRoot); }, [exportRoot]);
  const pendingCommit = useRef<Promise<boolean> | null>(null);
  const commitVjExportRoot = () => {
    const v = vjExportRoot.trim() || 'exports/vj';
    if (v !== exportRoot) pendingCommit.current = patchFeatures({ vj: { export_root: v } });
  };

  // Browse asks the VJ module for the folder: its picker opens at the current
  // export folder and stores the folder the user chooses as the setting.
  const [vjPicking, setVjPicking] = useState(false);
  const [vjPickError, setVjPickError] = useState<string | null>(null);
  const browseVjExportRoot = async () => {
    if (vjPicking) return;
    setVjPicking(true);
    setVjPickError(null);
    try {
      // Clicking Browse blurs the field first; let that commit land so the
      // picker opens at the folder that was just typed.
      await pendingCommit.current;
      const res = await postJson<{ cancelled?: boolean; path?: string }>('/api/vj/export-folder/pick');
      if (!res.cancelled && res.path) {
        setVjExportRoot(res.path);
        await refreshFeatures();
      }
    } catch (e) {
      setVjPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setVjPicking(false);
    }
  };

  const row = `${CARD} flex items-center gap-2 px-2 py-0.5 min-w-0`;
  return (
    <section aria-labelledby="settings-storage-title">
      <SectionHeader icon={<HardDrive className="w-3.5 h-3.5 text-purple-400" />} title="Storage"
        tip="Where models and data live on this PC (and inside WSL for Magenta). Hover a size for the models inside; Open shows the folder in Explorer. Sizes are cached for a minute — Refresh re-walks them.">
        {sizesLoading && <RefreshCw className="w-3 h-3 animate-spin text-zinc-400" />}
        <button type="button" onClick={() => load(true)} className={`${BTN_GHOST} ml-auto`} title="Re-walk every location">
          Refresh
        </button>
      </SectionHeader>
      <span id="settings-storage-title" className="sr-only">Storage</span>
      <div className="flex flex-col gap-1">
        {locations.map((loc) => (
          <div key={loc.key} className={row}>
            <span className="text-xs text-zinc-200 truncate shrink-0 max-w-[38%]" title={loc.label}>{loc.label}</span>
            <span className="text-[11px] font-mono text-zinc-500 truncate flex-1 min-w-0" title={loc.path ?? undefined}>{loc.path ?? 'not found'}</span>
            <span
              className={`text-[11px] font-mono text-zinc-300 tabular-nums shrink-0 ${loc.models?.length ? 'cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2' : ''}`}
              title={locationInventoryTitle(loc)}
            >
              {loc.exists ? formatBytes(loc.bytes) : '—'}
            </span>
            {loc.exists && loc.path && (
              <button
                type="button"
                onClick={() => { void openLocation(loc.path as string).catch(() => undefined); }}
                className={BTN_GHOST}
                aria-label={`Open ${loc.label} in Explorer`}
              >
                Open
              </button>
            )}
          </div>
        ))}

        {/* Hugging Face cache — an expandable row */}
        <div className={CARD}>
          <button
            type="button"
            onClick={() => setHfOpen((v) => !v)}
            aria-expanded={hfOpen}
            aria-controls="settings-hf-cache-list"
            className="w-full flex items-center gap-2 px-2 py-0.5 text-left"
          >
            <ChevronRight className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform ${hfOpen ? 'rotate-90' : ''}`} />
            <span className="text-xs text-zinc-200 flex-1 min-w-0 truncate">Hugging Face cache · {hfRepos.length} repos</span>
            <span className="text-[11px] font-mono text-zinc-300 tabular-nums shrink-0">{formatBytes(hfTotal)}</span>
          </button>
          <div id="settings-hf-cache-list" hidden={!hfOpen} className="flex flex-col gap-0.5 px-2 pb-1.5 max-h-40 overflow-y-auto">
            {hfRepos.map((r) => (
              <div key={r.repo_id} className="flex items-center gap-2 px-1.5 py-0.5 rounded border border-white/5">
                <span className="text-[11px] font-mono text-zinc-300 truncate flex-1" title={r.path}>{r.repo_id}</span>
                <span className="text-[11px] font-mono text-zinc-400 tabular-nums shrink-0">{formatBytes(r.bytes)}</span>
                <button
                  type="button"
                  onClick={() => { void openLocation(r.path).catch(() => undefined); }}
                  className={BTN_GHOST}
                  aria-label={`Open ${r.repo_id} in Explorer`}
                >
                  Open
                </button>
              </div>
            ))}
            {hfRepos.length === 0 && <p className="text-[11px] text-zinc-400 px-1.5 py-0.5">The cache is empty.</p>}
          </div>
        </div>

        {/* Media roots: where an entry's own copy is found on this PC */}
        <MediaRootsRows />

        {/* VJ recordings folder */}
        <div className={`${CARD} px-2 py-1`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label
              htmlFor="settings-vj-export-root"
              title={VJ_FOLDER_TIP}
              className="text-[9px] font-mono uppercase tracking-wider text-zinc-400 shrink-0 cursor-help"
            >
              VJ folder
            </label>
            <div className="flex gap-1.5 flex-1 min-w-0">
              <input
                id="settings-vj-export-root"
                name="settings-vj-export-root"
                type="text"
                value={vjExportRoot}
                title={VJ_FOLDER_TIP}
                onChange={(e) => setVjExportRoot(e.target.value)}
                onBlur={commitVjExportRoot}
                onKeyDown={(e) => { if (e.key === 'Enter') commitVjExportRoot(); }}
                spellCheck={false}
                placeholder="exports/vj"
                className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-purple-500/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void browseVjExportRoot()}
                disabled={vjPicking}
                aria-label="Choose the VJ recordings folder"
                title="Choose the VJ recordings folder"
                className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:border-purple-400/40 hover:bg-purple-500/15 hover:text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {vjPicking ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderOpen className="w-3 h-3" />}
                Browse
              </button>
            </div>
            {vjPickError && <p className="w-full text-[8px] text-red-300 leading-relaxed">{vjPickError}</p>}
          </div>
        </div>
      </div>
    </section>
  );
};
