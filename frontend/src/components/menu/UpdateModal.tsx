import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpCircle, CheckCircle2, ChevronDown, ChevronRight, Download, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Types + defensive JSON helpers (updates backend responses)          */
/* ------------------------------------------------------------------ */

interface ReleaseAsset {
  name: string;
  url: string;
}

interface CheckResult {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  notesExcerpt: string | null;
  assets: ReleaseAsset[];
  /** 'git' = clone (theDAW.bat / .sh / Pinokio / dev Electron); 'packaged' = installer build. */
  installKind: 'git' | 'packaged' | null;
  /** The backend can pull this install itself. */
  canApply: boolean;
  /** 'auto' = a supervisor respawns the backend after the pull; 'manual' = relaunch by hand. */
  restartMode: 'auto' | 'manual';
  error: string | null;
}

interface ReleaseRow {
  tag: string;
  name: string | null;
  publishedAt: string | null;
  url: string | null;
}

/** Progress of an in-place update, whichever path performs it. */
type ApplyPhase =
  | { kind: 'confirm' }
  | { kind: 'working'; step: string; message: string; logTail: string; percent: number | null }
  | { kind: 'reconnecting'; message: string }
  | { kind: 'relaunch'; message: string }
  | { kind: 'error'; message: string; logTail: string };

/** The desktop shell's updater bridge (electron-ui/preload/index.ts). */
interface DesktopUpdater {
  check: () => Promise<{ supported: boolean; reason?: string; version?: string | null; available?: boolean; error?: string }>;
  download: () => Promise<{ supported?: boolean; ok?: boolean; error?: string }>;
  install: () => Promise<{ ok: boolean; error?: string }>;
  onProgress: (cb: (info: { percent: number; transferred: number; total: number }) => void) => () => void;
}

const desktopUpdater = (): DesktopUpdater | null => {
  const api = (window as unknown as { electronAPI?: { isElectron?: boolean; platform?: string; updater?: DesktopUpdater } }).electronAPI;
  return api?.isElectron && api.updater ? api.updater : null;
};

const desktopPlatform = (): string | null =>
  (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform ?? null;

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const asBoolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const EMPTY_CHECK = (error: string): CheckResult => ({
  currentVersion: null,
  latestVersion: null,
  updateAvailable: null,
  releaseUrl: null,
  publishedAt: null,
  notesExcerpt: null,
  assets: [],
  installKind: null,
  canApply: false,
  restartMode: 'manual',
  error,
});

const normalizeCheck = (raw: unknown): CheckResult => {
  const j = asRecord(raw);
  const kind = asStr(j.install_kind);
  const assets = Array.isArray(j.assets)
    ? j.assets
        .map((a): ReleaseAsset | null => {
          const r = asRecord(a);
          const name = asStr(r.name);
          const url = asStr(r.url);
          return name && url ? { name, url } : null;
        })
        .filter((a): a is ReleaseAsset => a !== null)
    : [];
  return {
    currentVersion: asStr(j.current_version),
    latestVersion: asStr(j.latest_version),
    updateAvailable: asBoolOrNull(j.update_available),
    releaseUrl: asStr(j.release_url),
    publishedAt: asStr(j.published_at),
    notesExcerpt: asStr(j.notes_excerpt),
    assets,
    installKind: kind === 'git' || kind === 'packaged' ? kind : null,
    canApply: j.can_apply === true,
    restartMode: j.restart_mode === 'auto' ? 'auto' : 'manual',
    error: asStr(j.error),
  };
};

const normalizeReleases = (raw: unknown): ReleaseRow[] => {
  const arr = asRecord(raw).releases;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it): ReleaseRow | null => {
      const r = asRecord(it);
      const tag = asStr(r.tag);
      if (!tag) return null;
      return {
        tag,
        name: asStr(r.name),
        publishedAt: asStr(r.published_at),
        url: asStr(r.url),
      };
    })
    .filter((r): r is ReleaseRow => r !== null);
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
};

/** Open an external link in the system browser. In the packaged app the
 *  Electron main process routes http(s) window.open calls to the OS browser;
 *  in a plain browser this is a normal new tab. */
const openExternal = (url: string | null) => {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The macOS disk image in the release assets, if the release has one. */
const dmgAsset = (assets: ReleaseAsset[]): ReleaseAsset | null =>
  assets.find((a) => a.name.endsWith('.dmg')) ?? null;

/* ------------------------------------------------------------------ */
/* Shared styling (mirrors BackupModal)                                */
/* ------------------------------------------------------------------ */

const BTN =
  'flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60';
const BTN_PURPLE = `${BTN} border-purple-500/30 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20`;
const BTN_GHOST = `${BTN} border-white/10 bg-white/3 text-zinc-300 hover:bg-white/8`;

const SectionDivider: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-200">{label}</span>
    <div className="flex-1 h-px bg-white/10" />
  </div>
);

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

/**
 * Check for updates, confirm, and install in place.
 *
 * Three install kinds, one button:
 * - git clone (theDAW.bat / theDAW.sh / Pinokio / dev Electron): the backend
 *   pulls, exits with code 89, the supervisor syncs dependencies and respawns;
 *   this dialog polls /api/health and reloads the page when it is back.
 * - packaged Windows app: the Electron shell downloads the installer through
 *   electron-updater (progress shown here), then quits and runs it.
 * - packaged macOS app: the dmg is unsigned and cannot self-update, so the
 *   button downloads the new dmg.
 */
export const UpdateModal: React.FC<{
  open: boolean;
  onClose: () => void;
  initialShowReleases?: boolean;
}> = ({ open, onClose, initialShowReleases = false }) => {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [apply, setApply] = useState<ApplyPhase | null>(null);
  const applyRunning = useRef(false);

  const [showReleases, setShowReleases] = useState(initialShowReleases);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releases, setReleases] = useState<ReleaseRow[] | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);

  const runCheck = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const res = await fetch(`/api/updates/check${force ? '?force=true' : ''}`, {
        cache: 'no-store',
      });
      // The backend returns HTTP 200 with an `error` field when offline;
      // a non-2xx here is an unexpected server fault.
      if (!res.ok) {
        setCheck(EMPTY_CHECK(`Update service error (HTTP ${res.status}).`));
        return;
      }
      setCheck(normalizeCheck(await res.json()));
    } catch {
      setCheck(EMPTY_CHECK('Could not reach the release server.'));
    } finally {
      setChecking(false);
    }
  }, []);

  const loadReleases = useCallback(async () => {
    setReleasesLoading(true);
    setReleasesError(null);
    try {
      const res = await fetch('/api/updates/releases', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = asRecord(await res.json());
      const list = normalizeReleases(j);
      setReleases(list);
      const err = asStr(j.error);
      if (err && list.length === 0) setReleasesError('Could not reach the release server.');
    } catch {
      setReleases([]);
      setReleasesError('Could not reach the release server.');
    } finally {
      setReleasesLoading(false);
    }
  }, []);

  /** Wait for the backend to come back after the supervisor respawns it, then reload. */
  const waitForRestart = useCallback(async () => {
    setApply({ kind: 'reconnecting', message: 'Installing dependencies and restarting theDAW. This can take a few minutes on a big release.' });
    // The old process must be gone before a 200 means "new backend".
    await sleep(3000);
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* still down */
      }
      await sleep(1500);
    }
    setApply({ kind: 'error', message: 'theDAW did not come back within 20 minutes. Check the launcher console and relaunch it.', logTail: '' });
  }, []);

  /** Git-clone path: POST /apply, poll /apply-status, reconnect. */
  const applyViaBackend = useCallback(async () => {
    setApply({ kind: 'working', step: 'pull', message: 'Starting the update.', logTail: '', percent: null });
    let res: Response;
    try {
      res = await fetch('/api/updates/apply', { method: 'POST' });
    } catch {
      setApply({ kind: 'error', message: 'Could not reach theDAW to start the update.', logTail: '' });
      return;
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { detail?: unknown };
        if (typeof body.detail === 'string') detail = body.detail;
      } catch {
        /* keep the status */
      }
      setApply({ kind: 'error', message: detail, logTail: '' });
      return;
    }
    for (;;) {
      await sleep(1000);
      let status: Record<string, unknown>;
      try {
        const r = await fetch('/api/updates/apply-status', { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        status = asRecord(await r.json());
      } catch {
        // The backend exited for the restart before we saw 'restarting'.
        await waitForRestart();
        return;
      }
      const state = asStr(status.state);
      const message = asStr(status.message) ?? '';
      const logTail = asStr(status.log_tail) ?? '';
      if (state === 'restarting') {
        await waitForRestart();
        return;
      }
      if (state === 'done') {
        setApply({ kind: 'relaunch', message });
        return;
      }
      if (state === 'error') {
        setApply({ kind: 'error', message, logTail });
        return;
      }
      setApply({ kind: 'working', step: asStr(status.step) ?? '', message, logTail, percent: null });
    }
  }, [waitForRestart]);

  /** Packaged Windows path: electron-updater downloads, then quits into the installer. */
  const applyViaDesktop = useCallback(async (updater: DesktopUpdater) => {
    setApply({ kind: 'working', step: 'download', message: 'Downloading the installer.', logTail: '', percent: 0 });
    const off = updater.onProgress((p) => {
      setApply({ kind: 'working', step: 'download', message: `Downloading the installer (${Math.round(p.percent)}%).`, logTail: '', percent: p.percent });
    });
    try {
      const checked = await updater.check();
      if (!checked.supported) {
        setApply({ kind: 'error', message: `The desktop shell cannot self-update here (${checked.reason ?? 'unsupported'}).`, logTail: '' });
        return;
      }
      if (checked.error) {
        setApply({ kind: 'error', message: checked.error, logTail: '' });
        return;
      }
      if (!checked.available) {
        setApply({ kind: 'error', message: 'The desktop shell found no newer installer on the release feed yet. Try again in a few minutes.', logTail: '' });
        return;
      }
      const dl = await updater.download();
      if (!dl.ok) {
        setApply({ kind: 'error', message: dl.error ?? 'Download failed.', logTail: '' });
        return;
      }
      setApply({ kind: 'working', step: 'install', message: 'Installer ready. theDAW closes and the installer runs; it relaunches when done.', logTail: '', percent: 100 });
      const inst = await updater.install();
      if (!inst.ok) setApply({ kind: 'error', message: inst.error ?? 'Install failed.', logTail: '' });
    } finally {
      off();
    }
  }, []);

  const startUpdate = useCallback(async () => {
    if (applyRunning.current || !check) return;
    applyRunning.current = true;
    try {
      const updater = desktopUpdater();
      if (check.installKind === 'packaged') {
        if (updater && desktopPlatform() !== 'darwin') {
          await applyViaDesktop(updater);
        } else {
          // Unsigned macOS build: hand over the dmg.
          const dmg = dmgAsset(check.assets);
          openExternal(dmg?.url ?? check.releaseUrl);
          setApply({ kind: 'relaunch', message: dmg ? 'The new disk image is downloading. Quit theDAW, open it and drag theDAW to Applications.' : 'Download the new disk image from the release page, then replace theDAW in Applications.' });
        }
      } else {
        await applyViaBackend();
      }
    } finally {
      applyRunning.current = false;
    }
  }, [check, applyViaBackend, applyViaDesktop]);

  // Reset + kick off the version check whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setShowReleases(initialShowReleases);
    setReleases(null);
    setReleasesError(null);
    setApply(null);
    void runCheck(false);
  }, [open, initialShowReleases, runCheck]);

  // Lazy-load the releases list the first time it is expanded.
  useEffect(() => {
    if (open && showReleases && releases === null && !releasesLoading) {
      void loadReleases();
    }
  }, [open, showReleases, releases, releasesLoading, loadReleases]);

  const busy = apply !== null && (apply.kind === 'working' || apply.kind === 'reconnecting');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, busy]);

  if (!open) return null;

  const offline = check !== null && check.error !== null;
  const upToDate = check !== null && !offline && check.updateAvailable === false;
  const hasUpdate = check !== null && !offline && check.updateAvailable === true;
  // update_available is null when the version strings could not be compared.
  const indeterminate =
    check !== null && !offline && check.updateAvailable === null && check.latestVersion !== null;
  const canUpdateHere =
    check !== null && (check.canApply || check.installKind === 'packaged');

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-120 max-w-[92vw] max-h-[82vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/5 shrink-0">
          <ArrowUpCircle className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">
            Updates
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close updates dialog"
            className="ml-auto p-1 rounded border border-transparent text-zinc-400 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 disabled:opacity-40"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 min-h-0">
          {/* ---------------- Version status ---------------- */}
          <SectionDivider label="Version" />

          <div className="flex items-center gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                Installed
              </span>
              <span className="text-[11px] font-mono text-zinc-200">
                {check?.currentVersion ?? '--'}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                Latest
              </span>
              <span className="text-[11px] font-mono text-zinc-200">
                {checking ? '...' : (check?.latestVersion ?? '--')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void runCheck(true)}
              disabled={checking || busy}
              className={`${BTN_GHOST} ml-auto shrink-0`}
            >
              {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 text-purple-300" />}
              {offline ? 'Retry' : 'Check again'}
            </button>
          </div>

          {/* Status line */}
          {checking && !check && (
            <span className="text-[9px] font-mono text-zinc-600">checking for updates...</span>
          )}

          {offline && (
            <span className="text-[10px] text-amber-200">
              Could not reach the release server. Check your connection and retry.
            </span>
          )}

          {upToDate && (
            <div className="flex items-center gap-1.5 text-[10px] text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              You are up to date.
            </div>
          )}

          {indeterminate && (
            <span className="text-[10px] text-zinc-400">
              Latest published release is {check?.latestVersion}. Compare it against your installed
              version below.
            </span>
          )}

          {hasUpdate && (
            <div className="flex flex-col gap-2 rounded border border-purple-500/25 bg-purple-500/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-purple-200">
                <ArrowUpCircle className="w-3.5 h-3.5 shrink-0" />
                Update available: {check?.latestVersion}
                {check?.publishedAt && (
                  <span className="font-mono text-[8px] text-zinc-500 normal-case tracking-normal">
                    {fmtDate(check.publishedAt)}
                  </span>
                )}
              </div>
              {check?.notesExcerpt && (
                <p className="text-[9px] font-mono leading-snug text-zinc-400 whitespace-pre-wrap wrap-break-word max-h-24 overflow-y-auto">
                  {check.notesExcerpt}
                </p>
              )}

              {/* ---- apply flow ---- */}
              {apply === null && (
                <div className="flex items-center gap-2">
                  {canUpdateHere && (
                    <button
                      type="button"
                      onClick={() => setApply({ kind: 'confirm' })}
                      className={BTN_PURPLE}
                    >
                      <Download className="w-3 h-3" />
                      Update now
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => openExternal(check?.releaseUrl ?? null)}
                    disabled={!check?.releaseUrl}
                    className={BTN_GHOST}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Release page
                  </button>
                </div>
              )}

              {apply?.kind === 'confirm' && (
                <div className="flex flex-col gap-2 rounded border border-white/10 bg-black/30 p-2">
                  <span className="text-[10px] text-zinc-200">
                    Update to {check?.latestVersion} now?{' '}
                    {check?.installKind === 'packaged'
                      ? desktopPlatform() === 'darwin'
                        ? 'The new disk image downloads; you replace theDAW in Applications.'
                        : 'theDAW closes, the installer runs, and theDAW opens again.'
                      : check?.restartMode === 'auto'
                        ? 'theDAW pulls the new code, installs dependencies and restarts itself. Save your work first.'
                        : 'theDAW pulls the new code and installs dependencies; you relaunch it afterwards. Save your work first.'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void startUpdate()} className={BTN_PURPLE}>
                      <Download className="w-3 h-3" />
                      Update
                    </button>
                    <button type="button" onClick={() => setApply(null)} className={BTN_GHOST}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {apply?.kind === 'working' && (
                <div className="flex flex-col gap-1.5 rounded border border-white/10 bg-black/30 p-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-200">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    {apply.message}
                  </div>
                  {apply.percent !== null && (
                    <div className="h-1 w-full rounded bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(apply.percent)} aria-label="Download progress">
                      <div className="h-full bg-purple-400 transition-[width]" style={{ width: `${Math.max(0, Math.min(100, apply.percent))}%` }} />
                    </div>
                  )}
                  {apply.logTail && (
                    <pre className="text-[8px] font-mono leading-snug text-zinc-500 whitespace-pre-wrap wrap-break-word max-h-28 overflow-y-auto">
                      {apply.logTail}
                    </pre>
                  )}
                </div>
              )}

              {apply?.kind === 'reconnecting' && (
                <div className="flex items-center gap-1.5 rounded border border-white/10 bg-black/30 p-2 text-[10px] text-zinc-200">
                  <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  {apply.message}
                </div>
              )}

              {apply?.kind === 'relaunch' && (
                <div className="flex items-center gap-1.5 rounded border border-emerald-500/25 bg-emerald-500/5 p-2 text-[10px] text-emerald-200">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  {apply.message}
                </div>
              )}

              {apply?.kind === 'error' && (
                <div className="flex flex-col gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 p-2">
                  <span className="text-[10px] text-amber-200">{apply.message}</span>
                  {apply.logTail && (
                    <pre className="text-[8px] font-mono leading-snug text-zinc-500 whitespace-pre-wrap wrap-break-word max-h-28 overflow-y-auto">
                      {apply.logTail}
                    </pre>
                  )}
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setApply({ kind: 'confirm' })} className={BTN_GHOST}>
                      <RefreshCw className="w-3 h-3" />
                      Try again
                    </button>
                    <button type="button" onClick={() => openExternal(check?.releaseUrl ?? null)} className={BTN_GHOST}>
                      <ExternalLink className="w-3 h-3" />
                      Release page
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------------- Previous versions ---------------- */}
          <button
            type="button"
            onClick={() => setShowReleases((v) => !v)}
            aria-expanded={showReleases}
            className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-300 hover:text-zinc-100 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 rounded"
          >
            {showReleases ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            Previous versions
          </button>

          {showReleases && (
            <div className="flex flex-col gap-1.5">
              {releasesLoading && (
                <span className="text-[9px] font-mono text-zinc-600">loading releases...</span>
              )}
              {releasesError && !releasesLoading && (
                <span className="text-[9px] font-mono text-amber-300">{releasesError}</span>
              )}
              {releases !== null && releases.length === 0 && !releasesLoading && !releasesError && (
                <span className="text-[9px] font-mono text-zinc-600">No releases published yet.</span>
              )}
              {releases !== null && releases.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {releases.map((r) => (
                    <button
                      key={r.tag}
                      type="button"
                      onClick={() => openExternal(r.url)}
                      disabled={!r.url}
                      className="flex items-center gap-2 px-2 py-1 rounded text-left hover:bg-white/3 transition-colors disabled:opacity-50 outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
                    >
                      <span className="text-[10px] font-mono text-zinc-200 shrink-0">{r.tag}</span>
                      <span className="flex-1 min-w-0 truncate text-[9px] text-zinc-500">
                        {r.name ?? ''}
                      </span>
                      <span className="text-[8px] font-mono text-zinc-600 shrink-0">
                        {fmtDate(r.publishedAt)}
                      </span>
                      <ExternalLink className="w-3 h-3 text-zinc-500 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[9px] font-mono leading-snug text-zinc-600">
                Installing a different version is done by downloading and running that release's
                installer. Back up your data first from the menu.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
