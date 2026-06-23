import React, { useEffect, useState } from 'react';
import { Cloud, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { useSunoStore } from './sunoStore';
import { HoverTip, InfoTip } from '../components/ui/Tooltip';

const KEY_SECTION_TIP = {
  title: 'Suno API Key',
  body: 'Connect your Suno account so the app can generate music in the cloud.\n\n• Paste your secret sk_live_… key from platform.suno.com\n• It is stored on the backend only — never in the browser\n• Saving here instantly clears the “key required” banner in the generator\n• Paste a new key any time to replace the existing one',
};

interface KeyStatus {
  configured: boolean;
  key_prefix: string | null;
}

/**
 * SunoKeySettings — the intuitive home for the `sk_live_…` key (drop into the
 * Settings view). Self-contained: talks to the backend Suno proxy directly
 * (`/api/suno/status` + `/api/suno/key`) so the key stays server-side, and
 * refreshes the live panel state via the Suno store after saving (clears the
 * panel's "key required" banner).
 */
export const SunoKeySettings: React.FC = () => {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [val, setVal] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await fetch('/api/suno/status');
      setStatus(await r.json());
    } catch {
      setStatus({ configured: false, key_prefix: null });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    if (!val.trim()) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const r = await fetch('/api/suno/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: val.trim() }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.detail || `HTTP ${r.status}`);
      }
      setVal('');
      setSaved(true);
      await refresh();
      // Keep the live Suno panel in sync.
      void useSunoStore.getState().checkStatus();
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const configured = status?.configured;

  return (
    <div className="mb-3">
      {/* Section header + status pill */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <Cloud className="w-3 h-3 text-purple-400" />
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-300 flex items-center gap-1">
          Suno API <InfoTip {...KEY_SECTION_TIP} />
        </span>
        {status && (
          <span
            className={`ml-auto inline-flex items-center gap-1 text-[8px] font-mono px-1.5 py-0.5 rounded border ${
              configured
                ? 'text-green-300 bg-green-500/10 border-green-500/20'
                : 'text-amber-300 bg-amber-500/10 border-amber-500/20'
            }`}
          >
            {configured ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
            {configured ? `Connected · ${status.key_prefix}` : 'Not configured'}
          </span>
        )}
      </div>

      <div className="px-2 py-2 bg-white/3 border border-white/8 rounded flex flex-col gap-1.5">
        {/* Wrapped in a <form> so the password field has a containing form
            (silences the Chrome "password field is not contained in a form"
            warning) and Enter submits via the form, not an ad-hoc keydown. */}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor="suno-api-key" className="sr-only">
            Suno API key
          </label>
          <div className="relative flex-1">
            <input
              id="suno-api-key"
              type={show ? 'text' : 'password'}
              name="suno-api-key"
              autoComplete="off"
              className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 pr-7 text-[10px] font-mono text-zinc-200 outline-none focus:border-purple-500/50 transition-colors"
              placeholder={configured ? 'Paste a new key to replace…' : 'sk_live_…'}
              value={val}
              onChange={(e) => setVal(e.target.value)}
            />
            <HoverTip text={show ? 'Hide the key — mask the characters again.' : 'Show the key — reveal what you typed.'}>
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
                aria-label={show ? 'Hide the API key' : 'Show the API key'}
              >
                {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </HoverTip>
          </div>
          <HoverTip text="Save this key to the backend and reconnect the cloud generator.">
            <button
              type="submit"
              disabled={busy || !val.trim()}
              className="px-3 py-1.5 rounded border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-40 disabled:cursor-not-allowed text-purple-200 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3" /> : null}
              {busy ? 'Saving' : saved ? 'Saved' : 'Save'}
            </button>
          </HoverTip>
        </form>

        {err && <span className="text-[9px] text-red-400">{err}</span>}

        <a
          href="https://platform.suno.com"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-[9px] font-mono text-purple-300/70 hover:text-purple-200 transition-colors w-fit"
        >
          <ExternalLink className="w-2.5 h-2.5" /> Get a key at platform.suno.com
        </a>
      </div>
    </div>
  );
};
