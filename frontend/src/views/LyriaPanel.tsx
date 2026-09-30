import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Download, ExternalLink, Library, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { pairingHeaderFor } from '../lib/apiJson';
import { backendHttpBase } from '../lib/backendBase';
import { panelModelDefaults, panelModelOptions } from '../lib/cloudModels';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { probeLyriaCheckedOut } from '../state/generateStore';
import { useLibraryStore } from '../state/libraryStore';

// INT-002: how often the panel asks the backend to pull anything new out of
// the sidecar's own library. Generations take tens of seconds, so 30 s means a
// finished track shows up in the catalog without the user pressing anything.
const AUTO_SYNC_MS = 30000;
// How long the inline "3 imported" / "Nothing new" result stays up.
const SYNC_NOTE_MS = 4000;

// How often the panel asks how a running Update is doing.
const UPDATE_POLL_MS = 1500;
// An Update fetches, may run npm install (up to 10 min) and restarts Lyria.
const UPDATE_DEADLINE_MS = 20 * 60_000;

/** What the last Update or latest-commit check found (sidecar.checkout_state). */
interface LyriaCheckout {
  state: string;
  commit?: string | null;
  latest?: string | null;
  reason?: string;
}

/** GET /api/lyria/update. */
export interface LyriaUpdateReply {
  job: { status: string; message?: string; error?: string | null; restarted?: boolean; stopped?: boolean };
  checkout?: LyriaCheckout;
  latest?: { head: string | null; latest: string | null; available: boolean } | null;
}

/** GET /api/lyria/url and POST /api/lyria/restart. */
interface LyriaUrlReply {
  url: string;
  mock?: boolean | null;
  /** True when this Lyria was not started by this backend session. */
  external?: boolean;
  checkout?: LyriaCheckout;
}

/** Checkout states the backend left alone, with a reason worth reading. */
const CHECKOUT_LEFT_ALONE = new Set(['dirty', 'branch', 'diverged', 'failed', 'not_git', 'managed']);

/** The sentence to show under the header, or '' when there is nothing to say. */
export function lyriaCheckoutNote(checkout: LyriaCheckout | undefined): string {
  if (!checkout || !CHECKOUT_LEFT_ALONE.has(checkout.state)) return '';
  return checkout.reason ?? '';
}

/**
 * The line to show once an Update finished, or '' for none. A checkout the
 * backend left alone already says why in the checkout note, so a finished
 * Update adds nothing then; otherwise it says what moved (or that nothing
 * had to), and a failed one says why it failed.
 */
export function lyriaUpdateNote(reply: LyriaUpdateReply): string {
  if (reply.job.status === 'error') return reply.job.error || 'The update did not finish.';
  if (lyriaCheckoutNote(reply.checkout)) return '';
  return reply.job.message ?? '';
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// The Lyria 3 Pro app (StarskreamEXE/lyria-3-pro) is embedded WHOLE and
// unmodified: it ships its own Express server, its own SPA, its own settings
// and library. We spawn it (backend/modules/lyria) and frame it.
//
// Why an iframe rather than absorbing its UI: at its own origin the app's
// relative /api/* fetches resolve against its own server, so it needs no CORS,
// no base URL, and no client rewrite. Its viewport styling, its portals, its
// window event bus, and its Ctrl+Enter binding all apply to its own document
// and cannot collide with ours. Preserving it whole is what removes the work.
//
// This panel is therefore much thinner than VJView: Lyria drives its own
// transport and needs no postMessage bridge.
export const LyriaPanel: React.FC = () => {
  // This panel replaces the whole Make surface, hiding AdvancedGenPanel and the
  // real model dropdown with it. Without a selector here the user would be
  // stranded in the iframe with no route back to SA3 (same reason SunoGenPanel
  // carries one).
  const model = useGenerateParamsStore((s) => s.model);
  const patchParams = useGenerateParamsStore((s) => s.patch);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [mock, setMock] = useState<boolean | null>(null);
  // A Lyria this backend session did not start (left over from an earlier
  // run, or launched by hand): it keeps the keys and cost mode it started
  // with until it is restarted from here.
  const [external, setExternal] = useState(false);
  const [checkoutNote, setCheckoutNote] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState('');
  // Update: fast-forward the checkout to the latest commit of the Lyria repo.
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState('');
  const [updateNote, setUpdateNote] = useState('');
  const [updateFailed, setUpdateFailed] = useState(false);
  // The short id of a newer commit on GitHub, or '' when none is known.
  const [newerCommit, setNewerCommit] = useState('');
  // Bumped after a restart so the iframe reloads against the fresh child.
  const [frameKey, setFrameKey] = useState(0);
  const [detail, setDetail] = useState('');
  const [popped, setPopped] = useState(false);
  // INT-005: fails open (true) until the probe answers, same convention as
  // generateStore's own model-status gating — never hides the switcher's
  // options on a slow/unreachable probe.
  const [lyriaCheckedOut, setLyriaCheckedOut] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void probeLyriaCheckedOut().then((ok) => { if (!cancelled) setLyriaCheckedOut(ok); });
    return () => { cancelled = true; };
  }, []);

  // INT-002 — pulling the sidecar's generations into theDAW's library.
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState('');
  const syncNoteTimerRef = useRef<number | null>(null);
  // Guards the automatic 30 s tick against the button (and against itself on a
  // slow import): the backend serializes syncs anyway, but a second request
  // would sit there holding a connection for nothing.
  const syncBusyRef = useRef(false);

  const showSyncNote = useCallback((text: string) => {
    setSyncNote(text);
    if (syncNoteTimerRef.current !== null) window.clearTimeout(syncNoteTimerRef.current);
    syncNoteTimerRef.current = window.setTimeout(() => setSyncNote(''), SYNC_NOTE_MS);
  }, []);

  /**
   * Ask the backend to register every new sidecar generation as a library
   * entry. `announce` is the button: an automatic tick reports nothing and
   * never shows a spinner, so a background sync cannot flicker the top bar.
   *
   * `include_mock` is always false here. The sidecar defaults to mock mode
   * (its generations are synthesized sine waves that cost nothing), and
   * filling the user's library with those is not what this button is for.
   */
  const runSync = useCallback(
    async (announce: boolean) => {
      if (syncBusyRef.current) return;
      syncBusyRef.current = true;
      if (announce) setSyncing(true);
      try {
        const r = await fetch('/api/lyria/import-new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...pairingHeaderFor('/api/lyria/import-new') },
          body: JSON.stringify({ include_mock: false }),
        });
        if (!r.ok) throw new Error(`backend returned ${r.status}`);
        const j = (await r.json()) as {
          imported?: string[];
          skipped?: number;
          reason?: string;
        };
        const n = j.imported?.length ?? 0;
        // Exactly what sunoStore does when a clip completes: the backend has
        // already registered the entries, so the store only has to re-read.
        if (n > 0) await useLibraryStore.getState().refresh();
        if (announce) {
          if (n > 0) showSyncNote(`${n} imported`);
          else if (j.reason) showSyncNote(j.reason);
          else showSyncNote('Nothing new');
        }
      } catch (e) {
        // A failed sync is not a failed panel — the iframe keeps working.
        if (announce) showSyncNote(e instanceof Error ? e.message : 'Sync failed');
      } finally {
        syncBusyRef.current = false;
        if (announce) setSyncing(false);
      }
    },
    [showSyncNote],
  );

  // One sync the moment the iframe is live, then every 30 s while the panel
  // stays mounted and ready. The interval is cleared on unmount and whenever
  // the panel leaves 'ready', so a backgrounded tab stops polling.
  useEffect(() => {
    if (status !== 'ready') return;
    void runSync(false);
    const t = window.setInterval(() => void runSync(false), AUTO_SYNC_MS);
    return () => window.clearInterval(t);
  }, [status, runSync]);

  useEffect(
    () => () => {
      if (syncNoteTimerRef.current !== null) window.clearTimeout(syncNoteTimerRef.current);
    },
    [],
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const poppedWindowRef = useRef<Window | null>(null);
  const loadRetriesRef = useRef(0);
  const loadTimerRef = useRef<number | null>(null);
  const MAX_LOAD_RETRIES = 20; // ~40s of 2s retries

  const applyReply = (j: LyriaUrlReply) => {
    setUrl(j.url);
    setMock(j.mock ?? null);
    setExternal(Boolean(j.external));
    setCheckoutNote(lyriaCheckoutNote(j.checkout));
  };

  /**
   * End the Lyria on the port and start a fresh child with the current keys,
   * provider and cost mode. The one way to replace a Lyria this backend did
   * not start: a key change stops only a child it started itself. The
   * backend refuses (and says why) when the port holds something it will not
   * end, such as a Lyria running from another folder.
   */
  const restartLyria = async () => {
    setRestarting(true);
    setRestartError('');
    try {
      const r = await fetch('/api/lyria/restart', {
        method: 'POST',
        headers: pairingHeaderFor('/api/lyria/restart'),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(typeof body?.detail === 'string' ? body.detail : `backend returned ${r.status}`);
      }
      applyReply((await r.json()) as LyriaUrlReply);
      setFrameKey((k) => k + 1);
    } catch (e) {
      setRestartError(e instanceof Error ? e.message : 'Restart failed.');
    } finally {
      setRestarting(false);
    }
  };

  // Ask once, on open, whether GitHub has a commit this checkout does not.
  // The backend asks GitHub at most once per ten minutes however often this
  // runs.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/lyria/update?check=true')
      .then((r) => (r.ok ? (r.json() as Promise<LyriaUpdateReply>) : null))
      .then((j) => {
        if (cancelled || !j?.latest) return;
        setNewerCommit(j.latest.available && j.latest.latest ? j.latest.latest.slice(0, 7) : '');
      })
      .catch(() => {
        /* no answer: Update still works, it just cannot say in advance
           whether there is something new */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Fast-forward the Lyria checkout to the latest commit of its repo. The
   * backend stops Lyria for the move and starts it again, so the frame is
   * reloaded when it did. A checkout with local changes, on its own branch
   * or managed by the user is left alone, and the note says why.
   */
  const runUpdate = async () => {
    setUpdating(true);
    setUpdateNote('');
    setUpdateFailed(false);
    setUpdateProgress('Fetching the latest Lyria');
    try {
      const r = await fetch('/api/lyria/update', {
        method: 'POST',
        headers: pairingHeaderFor('/api/lyria/update'),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(typeof body?.detail === 'string' ? body.detail : `backend returned ${r.status}`);
      }
      const deadline = Date.now() + UPDATE_DEADLINE_MS;
      let reply: LyriaUpdateReply | null = null;
      while (Date.now() < deadline) {
        await sleep(UPDATE_POLL_MS);
        const s = await fetch('/api/lyria/update');
        if (!s.ok) continue;
        reply = (await s.json()) as LyriaUpdateReply;
        if (reply.job.status === 'done' || reply.job.status === 'error') break;
        if (reply.job.message) setUpdateProgress(reply.job.message);
      }
      if (!reply || (reply.job.status !== 'done' && reply.job.status !== 'error')) {
        throw new Error('Still updating. Check back in a minute.');
      }
      setUpdateFailed(reply.job.status === 'error');
      setCheckoutNote(lyriaCheckoutNote(reply.checkout));
      setUpdateNote(lyriaUpdateNote(reply));
      if (reply.job.status === 'done' && !lyriaCheckoutNote(reply.checkout)) setNewerCommit('');
      // Restarted: reload against the fresh child. Stopped and not started
      // again (a failed npm install, say): reload too, so the panel shows
      // Lyria starting or why it cannot, not a frame on a dead server.
      if (reply.job.restarted || reply.job.stopped) {
        setFrameKey((k) => k + 1);
        void loadUrl(true);
      }
    } catch (e) {
      setUpdateFailed(true);
      setUpdateNote(e instanceof Error ? e.message : 'The update did not finish.');
    } finally {
      setUpdating(false);
      setUpdateProgress('');
    }
  };

  // Same readiness contract as VJView: /api/lyria/url blocks server-side until
  // the child is listening, and we retry quietly while the backend is still
  // binding, so a cold start (npm install on a fresh checkout) renders
  // "Starting…" rather than an error.
  const loadUrl = async (manual = false) => {
    if (manual) loadRetriesRef.current = 0;
    if (loadTimerRef.current !== null) {
      window.clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    setStatus('loading');
    try {
      const r = await fetch('/api/lyria/url');
      if (!r.ok) {
        // The backend hands back the sidecar's own diagnostic (missing
        // checkout, npm absent, startup hang) — surface it rather than a code.
        let msg = `backend returned ${r.status}`;
        try {
          const body = (await r.json()) as { detail?: string };
          if (body.detail) msg = body.detail;
        } catch {
          /* non-JSON error body; keep the status line */
        }
        throw new Error(msg);
      }
      applyReply((await r.json()) as LyriaUrlReply);
      loadRetriesRef.current = 0;
      setStatus('ready');
      setDetail('');
    } catch (e) {
      if (loadRetriesRef.current < MAX_LOAD_RETRIES) {
        loadRetriesRef.current += 1;
        setStatus('loading');
        loadTimerRef.current = window.setTimeout(() => void loadUrl(), 2000);
      } else {
        setStatus('error');
        setDetail(e instanceof Error ? e.message : String(e));
      }
    }
  };

  useEffect(() => {
    void loadUrl();
    return () => {
      if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
    };
  }, []);

  // The sidecar returns an absolute http://127.0.0.1:<port> URL, so this
  // resolve is a no-op today. It is kept because backendHttpBase() is what
  // makes the packaged Electron app (origin app://.) work if the URL ever
  // becomes relative, and costs nothing.
  const lyriaSrc = useMemo(() => {
    if (!url) return null;
    try {
      return new URL(url, backendHttpBase()).toString();
    } catch {
      return url;
    }
  }, [url]);

  const popOut = () => {
    if (!lyriaSrc) return;
    const w = window.open(
      lyriaSrc,
      'thedaw-lyria-window',
      'noopener=no,width=1400,height=900,location=no,menubar=no,toolbar=no,status=no',
    );
    if (!w) {
      setDetail('Pop-out blocked — allow pop-ups for this origin, then try again.');
      window.setTimeout(() => setDetail(''), 6000);
      return;
    }
    poppedWindowRef.current = w;
    setPopped(true);
  };

  const popBackIn = () => {
    poppedWindowRef.current?.close();
    poppedWindowRef.current = null;
    setPopped(false);
  };

  // Snap back when the user closes the popped window directly.
  useEffect(() => {
    if (!popped) return;
    const t = window.setInterval(() => {
      if (poppedWindowRef.current?.closed) {
        poppedWindowRef.current = null;
        setPopped(false);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [popped]);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-800 shrink-0">
        {/* Functional, not decorative: this is the only signal telling the user
            whether GENERATE costs $0.08 or synthesizes a local mock. */}
        {mock !== null && (
          <span
            className={`text-xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${
              mock
                ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
            }`}
            title={
              mock
                ? 'Mock mode: generations synthesize a local WAV and cost nothing. Set theDAW_LYRIA_MOCK=0 to use the real Lyria 3 API.'
                : 'Live mode: every generation calls the real Lyria 3 API and costs $0.08 (Pro) or $0.04 (Clip) on your own key.'
            }
          >
            {mock ? 'Mock' : 'Live $0.08'}
          </span>
        )}
        {/* An adopted Lyria (left over from an earlier session, or launched
            by hand) has the keys and cost mode it started with. This is the
            one control that hands it the current ones. It also shows while
            the checkout note is up: the checkout was left where it is (local
            changes, its own branch, a folder the user manages), and a
            restart runs it as it is now, edits included, with the current
            keys. The visible text names the button. */}
        {status === 'ready' && (external || checkoutNote) && (
          <button
            type="button"
            onClick={() => void restartLyria()}
            disabled={restarting}
            title={
              external
                ? 'This Lyria was not started by this session of theDAW (a leftover from an earlier run, or one launched by hand), so it still has the keys and cost mode it started with. Restart it to hand it the current keys and cost mode.'
                : 'Stop Lyria and start it again from the checkout as it is now, local changes included, with the current keys and cost mode.'
            }
            className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 text-xs font-bold uppercase tracking-wide flex items-center gap-1 shrink-0 disabled:opacity-40"
          >
            {restarting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Restart with
            current keys
          </button>
        )}
        {/* Update: the checkout tracks the Lyria repo's latest commit. Shown
            in every state, since a Lyria that does not start may be one
            commit away from starting. The visible text names the button. */}
        <button
          type="button"
          onClick={() => void runUpdate()}
          disabled={updating}
          title={
            newerCommit
              ? `GitHub has a newer Lyria commit (${newerCommit}). Update fast-forwards this checkout to it and restarts Lyria. A checkout with local changes or on its own branch is left alone.`
              : 'Fetch the latest Lyria from GitHub and fast-forward this checkout to it, restarting Lyria. A checkout with local changes or on its own branch is left alone.'
          }
          className="px-2 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-200 text-xs font-bold uppercase tracking-wide flex items-center gap-1 shrink-0 disabled:opacity-40"
        >
          {updating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} Update Lyria
        </button>
        {newerCommit && !updating && (
          <span className="text-xs font-bold text-sky-300 shrink-0">New commit {newerCommit}</span>
        )}
        <div className="flex-1" />
        {/* INT-002: Lyria's own library is inside the sidecar. This is the
            hand-off that makes a generation a theDAW entry — catalog, lineage,
            EDIT, stems, export — the way a finished Suno clip already is. */}
        <button
          type="button"
          onClick={() => void runSync(true)}
          disabled={syncing}
          aria-label="Sync Lyria generations to the theDAW library"
          title="Import every new Lyria generation into theDAW's library (catalog, lineage, EDIT, stems, export). Runs automatically every 30 seconds too. Mock generations are never imported."
          className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-xs font-bold uppercase tracking-wide flex items-center gap-1 shrink-0 disabled:opacity-40"
        >
          {syncing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Library className="w-3 h-3" />
          )}{' '}
          Sync to library
        </button>
        {syncNote && (
          <span
            aria-live="polite"
            className="text-xs font-bold text-zinc-400 shrink-0 max-w-48 truncate"
          >
            {syncNote}
          </span>
        )}
        <div className="relative shrink-0">
          <label htmlFor="lyria-model" className="sr-only">
            Active model
          </label>
          <select
            id="lyria-model"
            name="lyria-model"
            className="appearance-none rounded-full border border-purple-400/30 bg-purple-500/10 hover:bg-purple-500/15 pl-3 pr-7 py-1 text-xs font-bold uppercase tracking-wider text-purple-100 outline-none transition-colors cursor-pointer"
            value={model}
            onChange={(e) => {
              const m = e.target.value;
              // FE-006: patching model alone left the RF-Inversion-era
              // steps/cfg defaults stale on an ARC selection (or vice versa)
              // until the real MAKE dropdown was touched — mirror it here.
              patchParams({ model: m, ...panelModelDefaults(m) });
            }}
            style={{ colorScheme: 'dark' }}
            title="Switch the active model. Pick a Stable Audio model to return to the local generator."
          >
            {panelModelOptions(model, lyriaCheckedOut).map((m) => (
              <option
                key={m.value}
                value={m.value}
                className="bg-[#0a080f] text-zinc-200 normal-case tracking-normal"
              >
                {m.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-purple-300/70 text-xs">
            ▾
          </span>
        </div>
        {status === 'ready' && !popped && (
          <button
            type="button"
            onClick={popOut}
            className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-xs font-bold uppercase tracking-wide flex items-center gap-1 shrink-0"
            title="Open Lyria in a separate window"
          >
            <ExternalLink className="w-3 h-3" /> Pop out
          </button>
        )}
      </div>
      {/* How an Update is going and how it ended, why the checkout was left
          where it is (local changes, its own branch, no network, a checkout
          the user manages), and a refused restart. */}
      {(checkoutNote || restartError || updateProgress || updateNote) && (
        <div className="flex flex-col gap-0.5 px-2 py-1 border-b border-zinc-800 shrink-0">
          {updateProgress && (
            <p role="status" className="text-xs font-bold leading-snug text-sky-200">
              {updateProgress}
            </p>
          )}
          {checkoutNote && (
            <p role="status" className="text-xs font-bold leading-snug text-amber-200">
              {checkoutNote}
            </p>
          )}
          {updateNote && (
            <p
              role={updateFailed ? 'alert' : 'status'}
              className={`text-xs font-bold leading-snug ${updateFailed ? 'text-rose-300' : 'text-emerald-200'}`}
            >
              {updateNote}
            </p>
          )}
          {restartError && (
            <p role="alert" className="text-xs font-bold leading-snug text-rose-300">
              {restartError}
            </p>
          )}
        </div>
      )}

      <div className="flex-1 relative min-h-0">
        {status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
            <span className="text-sm">Starting Lyria…</span>
            <span className="text-xs font-bold text-zinc-500">First launch can take a minute.</span>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-300 px-6">
            <AlertCircle className="w-5 h-5 text-zinc-500" />
            <span className="text-sm">Lyria didn’t start.</span>
            {detail && (
              <span className="text-xs font-bold text-zinc-400 text-center max-w-md">{detail}</span>
            )}
            <button
              type="button"
              onClick={() => void loadUrl(true)}
              className="mt-1 px-3 py-1.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-xs flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}
        {status === 'ready' && popped && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-300">
            <ExternalLink className="w-5 h-5" />
            <span className="text-xs font-bold uppercase tracking-wide">Lyria is in a separate window</span>
            <button
              type="button"
              onClick={popBackIn}
              className="px-3 py-1.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-xs font-black uppercase tracking-wide"
            >
              Pop back in
            </button>
          </div>
        )}
        {status === 'ready' && !popped && lyriaSrc && (
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={lyriaSrc}
            // Lyria records nothing and captures nothing; it needs autoplay for
            // its transport and clipboard-write for its prompt/lyrics copy
            // affordances. Nothing else is granted.
            allow="autoplay; clipboard-write"
            // sandbox is deliberately NOT set: this is a sibling app we spawn
            // ourselves on loopback, and it needs full window APIs (AudioContext,
            // localStorage for its own settings).
            className="w-full h-full border-0 bg-black"
            title="Lyria 3 Pro"
          />
        )}
      </div>
    </div>
  );
};
