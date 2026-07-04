import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Types + defensive JSON helpers (updates backend responses)          */
/* ------------------------------------------------------------------ */

interface CheckResult {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  notesExcerpt: string | null;
  error: string | null;
}

interface ReleaseRow {
  tag: string;
  name: string | null;
  publishedAt: string | null;
  url: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const asBoolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const normalizeCheck = (raw: unknown): CheckResult => {
  const j = asRecord(raw);
  return {
    currentVersion: asStr(j.current_version),
    latestVersion: asStr(j.latest_version),
    updateAvailable: asBoolOrNull(j.update_available),
    releaseUrl: asStr(j.release_url),
    publishedAt: asStr(j.published_at),
    notesExcerpt: asStr(j.notes_excerpt),
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
 * Update check + restore-previous-version dialog. On open it queries
 * /api/updates/check (current vs latest published GitHub release) and, when
 * the releases list is expanded, /api/updates/releases. Installing a specific
 * version is installer-driven: the modal only surfaces the download-page URLs.
 */
export const UpdateModal: React.FC<{
  open: boolean;
  onClose: () => void;
  initialShowReleases?: boolean;
}> = ({ open, onClose, initialShowReleases = false }) => {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);

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
        setCheck({
          currentVersion: null,
          latestVersion: null,
          updateAvailable: null,
          releaseUrl: null,
          publishedAt: null,
          notesExcerpt: null,
          error: `Update service error (HTTP ${res.status}).`,
        });
        return;
      }
      setCheck(normalizeCheck(await res.json()));
    } catch {
      setCheck({
        currentVersion: null,
        latestVersion: null,
        updateAvailable: null,
        releaseUrl: null,
        publishedAt: null,
        notesExcerpt: null,
        error: 'Could not reach the release server.',
      });
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

  // Reset + kick off the version check whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setShowReleases(initialShowReleases);
    setReleases(null);
    setReleasesError(null);
    void runCheck(false);
  }, [open, initialShowReleases, runCheck]);

  // Lazy-load the releases list the first time it is expanded.
  useEffect(() => {
    if (open && showReleases && releases === null && !releasesLoading) {
      void loadReleases();
    }
  }, [open, showReleases, releases, releasesLoading, loadReleases]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const offline = check !== null && check.error !== null;
  const upToDate = check !== null && !offline && check.updateAvailable === false;
  const hasUpdate = check !== null && !offline && check.updateAvailable === true;
  // update_available is null when the version strings could not be compared.
  const indeterminate =
    check !== null && !offline && check.updateAvailable === null && check.latestVersion !== null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
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
            aria-label="Close updates dialog"
            className="ml-auto p-1 rounded border border-transparent text-zinc-400 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
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
              disabled={checking}
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
              <button
                type="button"
                onClick={() => openExternal(check?.releaseUrl ?? null)}
                disabled={!check?.releaseUrl}
                className={`${BTN_PURPLE} self-start`}
              >
                <ExternalLink className="w-3 h-3" />
                Open release page
              </button>
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
