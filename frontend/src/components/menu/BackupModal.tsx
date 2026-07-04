import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, FolderOpen, HardDriveDownload, HardDriveUpload, Loader2, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Types + defensive JSON helpers (backup backend responses)           */
/* ------------------------------------------------------------------ */

interface BackupRoot {
  id: string;
  label: string;
  path: string | null;
  sizeBytes: number | null;
}

interface JobView {
  state: 'idle' | 'running' | 'done' | 'error';
  progress: number; // 0..1
  message: string;
  zipPath: string | null;
  error: string | null;
}

const IDLE_JOB: JobView = { state: 'idle', progress: 0, message: '', zipPath: null, error: null };

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const asNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const humanSize = (n: number | null): string => {
  if (n === null || n < 0) return '--';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

const normalizeRoots = (raw: unknown): BackupRoot[] => {
  const j = asRecord(raw);
  const arr = Array.isArray(j.roots) ? j.roots : Array.isArray(raw) ? (raw as unknown[]) : [];
  return arr
    .map((it): BackupRoot | null => {
      const r = asRecord(it);
      const id = asStr(r.id) ?? asStr(r.key) ?? asStr(r.name);
      if (!id) return null;
      return {
        id,
        label: asStr(r.label) ?? asStr(r.name) ?? id,
        path: asStr(r.path) ?? null,
        sizeBytes: asNum(r.size_bytes) ?? asNum(r.bytes) ?? asNum(r.size),
      };
    })
    .filter((r): r is BackupRoot => r !== null);
};

const normalizeJob = (raw: unknown): JobView => {
  const j = asRecord(raw);
  const s = String(j.state ?? j.status ?? 'running').toLowerCase();
  const state: JobView['state'] =
    s === 'done' || s === 'complete' || s === 'completed' || s === 'finished' || s === 'ok'
      ? 'done'
      : s === 'error' || s === 'failed'
        ? 'error'
        : 'running';
  let p = asNum(j.progress) ?? asNum(j.percent) ?? 0;
  if (p > 1) p = p / 100;
  p = Math.max(0, Math.min(1, p));
  if (state === 'done') p = 1;
  return {
    state,
    progress: p,
    message: asStr(j.message) ?? asStr(j.current) ?? asStr(j.stage) ?? '',
    zipPath: asStr(j.zip_path) ?? asStr(j.path) ?? asStr(j.output) ?? null,
    error: asStr(j.error) ?? asStr(j.detail) ?? null,
  };
};

const errText = async (res: Response): Promise<string> => {
  try {
    const j = asRecord(await res.clone().json());
    const d = j.detail ?? j.error;
    if (typeof d === 'string' && d) return d;
    if (d !== undefined && d !== null) return JSON.stringify(d);
  } catch {
    /* body is not json */
  }
  try {
    const t = await res.text();
    if (t) return t.slice(0, 300);
  } catch {
    /* unreadable body */
  }
  return `Request failed (HTTP ${res.status})`;
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Shared styling                                                      */
/* ------------------------------------------------------------------ */

const BTN =
  'flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60';
const BTN_PURPLE = `${BTN} border-purple-500/30 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20`;
const BTN_GHOST = `${BTN} border-white/10 bg-white/3 text-zinc-300 hover:bg-white/8`;
const INPUT_CLS =
  'flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-purple-500/50';
const ERR_CLS = 'text-[9px] font-mono text-red-400 break-all';

const SectionDivider: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-200">{label}</span>
    <div className="flex-1 h-px bg-white/10" />
  </div>
);

const ProgressBar: React.FC<{ job: JobView }> = ({ job }) => (
  <div className="flex flex-col gap-1">
    <div className="h-1 rounded bg-white/10 overflow-hidden">
      <div
        className="h-full bg-purple-500 transition-all"
        style={{ width: `${Math.round(job.progress * 100)}%` }}
      />
    </div>
    <span className="text-[9px] font-mono text-zinc-500 truncate">
      {Math.round(job.progress * 100)}%{job.message ? ` - ${job.message}` : ''}
    </span>
  </div>
);

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

/**
 * Backup / Migrate dialog. Exports the selected user-data roots into a zip at
 * a chosen destination folder, and imports a previously exported backup zip
 * (merge or replace). Talks to the /api/backup/* module and polls its job
 * status endpoints while an export or import runs.
 */
export const BackupModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [roots, setRoots] = useState<BackupRoot[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [manifestError, setManifestError] = useState<string | null>(null);

  const [destination, setDestination] = useState('');
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const [exportJob, setExportJob] = useState<JobView>(IDLE_JOB);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importPath, setImportPath] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importJob, setImportJob] = useState<JobView>(IDLE_JOB);
  const [importError, setImportError] = useState<string | null>(null);

  // Bumping the token cancels any in-flight poll loop (close/unmount).
  const tokenRef = useRef(0);
  useEffect(() => {
    return () => {
      tokenRef.current += 1;
    };
  }, []);

  const loadManifest = useCallback(async () => {
    setManifestError(null);
    setRoots(null);
    try {
      const res = await fetch('/api/backup/manifest');
      if (!res.ok) throw new Error(await errText(res));
      const list = normalizeRoots(await res.json());
      setRoots(list);
      setSelected(new Set(list.map((r) => r.id)));
    } catch (e) {
      setRoots([]);
      setManifestError(e instanceof Error ? e.message : 'Could not load the backup manifest.');
    }
  }, []);

  useEffect(() => {
    if (!open) {
      tokenRef.current += 1;
      return;
    }
    setExportJob(IDLE_JOB);
    setExportError(null);
    setImportJob(IDLE_JOB);
    setImportError(null);
    setPickError(null);
    void loadManifest();
  }, [open, loadManifest]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const toggleRoot = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const pickFolder = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const res = await fetch('/api/backup/pick-folder');
      if (!res.ok) throw new Error(await errText(res));
      const j = asRecord(await res.json());
      const path = asStr(j.path);
      if (path) setDestination(path);
      // A missing path means the user cancelled the native dialog: no-op.
    } catch (e) {
      setPickError(e instanceof Error ? e.message : 'Folder picker failed.');
    } finally {
      setPicking(false);
    }
  };

  const pollUntilDone = async (
    statusUrl: string,
    update: (s: JobView) => void,
  ): Promise<JobView | null> => {
    const token = tokenRef.current;
    for (;;) {
      await sleep(700);
      if (tokenRef.current !== token) return null;
      const res = await fetch(statusUrl);
      if (!res.ok) throw new Error(await errText(res));
      const s = normalizeJob(await res.json());
      if (tokenRef.current !== token) return null;
      update(s);
      if (s.state === 'done' || s.state === 'error') return s;
    }
  };

  const startExport = async () => {
    setExportError(null);
    setExportJob({ ...IDLE_JOB, state: 'running', message: 'starting...' });
    try {
      const res = await fetch('/api/backup/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest_dir: destination.trim(), include: Array.from(selected) }),
      });
      if (!res.ok) throw new Error(await errText(res));
      const jobId = asStr(asRecord(await res.json()).job);
      if (!jobId) throw new Error('Export did not return a job id.');
      const final = await pollUntilDone(
        `/api/backup/export/status?job=${encodeURIComponent(jobId)}`,
        setExportJob,
      );
      if (!final) return; // dialog closed mid-run
      if (final.state === 'error') {
        setExportError(final.error || 'Export failed.');
        setExportJob(IDLE_JOB);
      }
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
      setExportJob(IDLE_JOB);
    }
  };

  const startImport = async () => {
    setImportError(null);
    setImportJob({ ...IDLE_JOB, state: 'running', message: 'starting...' });
    try {
      const res = await fetch('/api/backup/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip_path: importPath.trim(), mode: importMode }),
      });
      if (!res.ok) throw new Error(await errText(res));
      const jobId = asStr(asRecord(await res.json()).job);
      if (!jobId) throw new Error('Import did not return a job id.');
      const final = await pollUntilDone(
        `/api/backup/import/status?job=${encodeURIComponent(jobId)}`,
        setImportJob,
      );
      if (!final) return;
      if (final.state === 'error') {
        setImportError(final.error || 'Import failed.');
        setImportJob(IDLE_JOB);
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.');
      setImportJob(IDLE_JOB);
    }
  };

  if (!open) return null;

  const exporting = exportJob.state === 'running';
  const importing = importJob.state === 'running';
  const busy = exporting || importing;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-120 max-w-[92vw] max-h-[82vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <Archive className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">
            Backup / Migrate
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close backup dialog"
            className="ml-auto p-1 rounded border border-transparent text-zinc-400 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 min-h-0">
          {/* ---------------- Export ---------------- */}
          <SectionDivider label="Export" />

          {roots === null && !manifestError && (
            <span className="text-[9px] font-mono text-zinc-600 py-2">loading manifest...</span>
          )}
          {manifestError && <span className={ERR_CLS}>{manifestError}</span>}
          {roots !== null && roots.length === 0 && !manifestError && (
            <span className="text-[9px] font-mono text-zinc-600">No backup roots reported.</span>
          )}

          {roots !== null && roots.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {roots.map((r) => (
                <label
                  key={r.id}
                  htmlFor={`backup-root-${r.id}`}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/3 cursor-pointer"
                  title={r.path ?? r.label}
                >
                  <input
                    type="checkbox"
                    id={`backup-root-${r.id}`}
                    name={`backup-root-${r.id}`}
                    checked={selected.has(r.id)}
                    onChange={(e) => toggleRoot(r.id, e.target.checked)}
                    disabled={busy}
                    className="w-3 h-3 accent-purple-500 shrink-0"
                  />
                  <span className="flex-1 min-w-0 truncate text-[10px] text-zinc-300">{r.label}</span>
                  <span className="text-[9px] font-mono text-zinc-500 shrink-0">
                    {humanSize(r.sizeBytes)}
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Destination */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="backup-destination"
              className="text-[9px] font-mono uppercase tracking-wider text-zinc-300"
            >
              Destination
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                id="backup-destination"
                name="backup-destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="Folder for the backup zip"
                disabled={busy}
                className={INPUT_CLS}
              />
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={picking || busy}
                className={`${BTN_GHOST} shrink-0`}
              >
                {picking ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <FolderOpen className="w-3 h-3 text-purple-300" />
                )}
                Choose folder
              </button>
            </div>
            {pickError && <span className={ERR_CLS}>{pickError}</span>}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void startExport()}
              disabled={busy || !destination.trim() || selected.size === 0}
              className={BTN_PURPLE}
            >
              {exporting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <HardDriveDownload className="w-3 h-3" />
              )}
              Export
            </button>
            {exportJob.state === 'done' && exportJob.zipPath && (
              <span className="text-[9px] font-mono text-emerald-300 break-all min-w-0">
                {exportJob.zipPath}
              </span>
            )}
          </div>
          {exporting && <ProgressBar job={exportJob} />}
          {exportError && <span className={ERR_CLS}>{exportError}</span>}

          {/* ---------------- Import ---------------- */}
          <SectionDivider label="Import" />

          <div className="flex flex-col gap-1">
            <label
              htmlFor="backup-import-path"
              className="text-[9px] font-mono uppercase tracking-wider text-zinc-300"
            >
              Backup zip
            </label>
            <input
              type="text"
              id="backup-import-path"
              name="backup-import-path"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder="Path to a theDAW backup .zip"
              disabled={busy}
              className={INPUT_CLS}
            />
          </div>

          <div className="flex items-center gap-4">
            <label
              htmlFor="backup-import-merge"
              className="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer"
            >
              <input
                type="radio"
                id="backup-import-merge"
                name="backup-import-mode"
                value="merge"
                checked={importMode === 'merge'}
                onChange={() => setImportMode('merge')}
                disabled={busy}
                className="w-3 h-3 accent-purple-500"
              />
              Merge
            </label>
            <label
              htmlFor="backup-import-replace"
              className="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer"
            >
              <input
                type="radio"
                id="backup-import-replace"
                name="backup-import-mode"
                value="replace"
                checked={importMode === 'replace'}
                onChange={() => setImportMode('replace')}
                disabled={busy}
                className="w-3 h-3 accent-purple-500"
              />
              Replace
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void startImport()}
              disabled={busy || !importPath.trim()}
              className={BTN_PURPLE}
            >
              {importing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <HardDriveUpload className="w-3 h-3" />
              )}
              Import
            </button>
            {importJob.state === 'done' && (
              <span className="text-[9px] font-mono text-emerald-300 min-w-0 break-all">
                Import complete{importJob.message ? ` - ${importJob.message}` : '.'}
              </span>
            )}
          </div>
          {importing && <ProgressBar job={importJob} />}
          {importError && <span className={ERR_CLS}>{importError}</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
};
