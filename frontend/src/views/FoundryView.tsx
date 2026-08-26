/**
 * FOUNDRY tab — embeds the VST Foundry app (a visual VST/plugin UI builder)
 * in an iframe. Foundry is a fullstack Node app that serves ITSELF on its own
 * port, so unlike VJ there is no static mount or control bridge: we just fetch
 * its live URL from `/api/foundry/url` (which spawns the sidecar on first call)
 * and point the iframe at it. First launch can take a while — the Node server
 * installs deps and boots — so we retry the fetch and show a clear state.
 *
 * "Pop out" opens the same URL in a standalone window for a full-screen design
 * surface. When Foundry isn't available (no Node.js / no project), the backend
 * returns a 503 whose message we surface verbatim.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Hammer, RotateCw } from 'lucide-react';
import { SkreambotCredit } from '../components/ui/Credit';
import { UI_MODES, useAppUiStore, type UiMode } from '../state/appUiStore';

const MAX_LOAD_RETRIES = 40; // ~80s at 2s spacing — first boot builds the app

export const FoundryView: React.FC = () => {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<string>('');
  const retriesRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const uiMode = useAppUiStore((s) => s.uiMode);
  const setUiMode = useAppUiStore((s) => s.setUiMode);
  // The boot mode rides the iframe URL; later flips go over postMessage so the
  // Foundry editor never reloads (and never drops selection/undo) mid-session.
  const modeRef = useRef<UiMode>(uiMode);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeLoadedRef = useRef(false);
  const originRef = useRef<string>('');

  useEffect(() => {
    modeRef.current = uiMode;
  }, [uiMode]);

  const loadUrl = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStatus('loading');
    try {
      const r = await fetch('/api/foundry/url');
      if (!r.ok) {
        // Surface the backend's diagnostic (e.g. "install Node.js") verbatim.
        let msg = `backend returned ${r.status}`;
        try {
          const j = (await r.json()) as { detail?: string };
          if (j.detail) msg = j.detail;
        } catch { /* non-JSON body */ }
        throw new Error(msg);
      }
      const j = (await r.json()) as { url: string };
      const u = new URL(j.url);
      u.searchParams.set('uiMode', modeRef.current);
      originRef.current = u.origin;
      iframeLoadedRef.current = false;
      setUrl(u.toString());
      retriesRef.current = 0;
      setStatus('ready');
      setDetail('');
    } catch (e) {
      if (retriesRef.current < MAX_LOAD_RETRIES) {
        retriesRef.current += 1;
        setStatus('loading');
        setDetail('starting the VST Foundry server (first launch can take a minute)…');
        timerRef.current = window.setTimeout(() => void loadUrl(), 2000);
      } else {
        setStatus('error');
        setDetail(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    void loadUrl();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [loadUrl]);

  const retry = () => {
    retriesRef.current = 0;
    void loadUrl();
  };

  // Push mode flips into the running iframe (origin-pinned, never '*').
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (win && iframeLoadedRef.current && originRef.current) {
      win.postMessage({ type: 'foundry/ui-mode', mode: uiMode }, originRef.current);
    }
  }, [uiMode]);

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0a080f]">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-white/5 shrink-0">
        <Hammer className="w-3.5 h-3.5 text-amber-300" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-amber-200/80">
          VST Foundry
        </span>
        <span className="w-px h-4 bg-white/10 shrink-0" />
        <SkreambotCredit className="shrink-0" />
        <div className="flex-1" />
        {/* Kouhai = app-like simplified skin of the SAME Foundry (zero features
            removed); Senpai = the full cockpit. Lives here, on the surface it
            gates, not in the shell header. */}
        <div role="group" aria-label="Foundry interface mode" className="flex items-center gap-1 mr-1">
          {UI_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setUiMode(m)}
              aria-pressed={uiMode === m}
              title={m === 'kouhai'
                ? 'Kouhai: app-like simplified Foundry, every feature intact'
                : 'Senpai: the full Foundry cockpit'}
              className={`px-2 py-0.5 rounded border text-[10px] font-black uppercase tracking-widest transition-colors ${
                uiMode === m
                  ? 'border-amber-400/60 bg-amber-500/15 text-amber-100'
                  : 'border-white/10 text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={retry}
          aria-label="Reload VST Foundry"
          title="Reload VST Foundry"
          className="btn-ghost inline-flex items-center gap-1 text-[10px]"
        >
          <RotateCw className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!url) return;
            const u = new URL(url);
            u.searchParams.set('uiMode', modeRef.current);
            window.open(u.toString(), '_blank', 'noopener,noreferrer');
          }}
          disabled={!url}
          aria-label="Open VST Foundry in a new window"
          title="Open in a new window"
          className="btn-ghost inline-flex items-center gap-1 text-[10px] disabled:opacity-40"
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {status === 'ready' && url ? (
          <iframe
            ref={iframeRef}
            src={url}
            title="VST Foundry"
            className="absolute inset-0 w-full h-full border-0 bg-white"
            allow="clipboard-read; clipboard-write"
            onLoad={() => {
              iframeLoadedRef.current = true;
              // Re-sync in case the mode flipped while the app was booting.
              const win = iframeRef.current?.contentWindow;
              if (win && originRef.current) {
                win.postMessage({ type: 'foundry/ui-mode', mode: modeRef.current }, originRef.current);
              }
            }}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            {status === 'loading' ? (
              <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-500 animate-pulse">
                {detail || 'loading VST Foundry…'}
              </span>
            ) : (
              <div className="max-w-md space-y-3">
                <p className="text-xs text-red-300/90 font-mono">VST Foundry unavailable</p>
                <p className="text-[11px] text-zinc-400 whitespace-pre-wrap wrap-break-word">{detail}</p>
                <button
                  type="button"
                  onClick={retry}
                  className="btn-ghost inline-flex items-center gap-1 text-[11px]"
                >
                  <RotateCw className="w-3 h-3" /> Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
