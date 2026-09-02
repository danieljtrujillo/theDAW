/**
 * HfTokenField — paste-a-Hugging-Face-token control, rendered wherever the app
 * warns that a token is needed.
 *
 * The rule this component exists to enforce: the window that warns you is the
 * window you fix it in. No env var, no restart, no hunting through Settings.
 * Paste the token, hit Save, and the same card tells you it worked — then
 * `onSignedIn` re-runs whatever failed (retry the download, refresh the model
 * status) so the user never has to find their way back to it.
 *
 * It reads /api/hfauth/status on mount so an already-signed-in user sees
 * "Signed in as <name>" instead of a pointless empty box, and POSTs to
 * /api/hfauth/login on submit, which validates via whoami and persists the
 * token to huggingface_hub's standard store — every later download picks it up.
 *
 * Call sites: Settings → Models (Hugging Face row), the DownloadDock error
 * block (gated / rate-limited downloads), and the feature-gate notice stack.
 * `idPrefix` keeps the input id unique when two of these are on screen at once.
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { fetchHfStatus, hfLogin, hfLoginUrl, HfAuthError, type HfAuthStatus } from '../../lib/hfAuthClient';

type Accent = 'purple' | 'rose' | 'yellow';

/** Save-button colour per host surface, so the field reads as part of the card. */
const ACCENTS: Record<Accent, { button: string; focus: string }> = {
  purple: {
    button:
      'border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25 focus-visible:ring-purple-400/70',
    focus: 'focus:border-purple-500/50',
  },
  rose: {
    button:
      'border-rose-400/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 focus-visible:ring-rose-400/70',
    focus: 'focus:border-rose-400/60',
  },
  yellow: {
    button:
      'border-yellow-400/40 bg-yellow-400/10 text-yellow-200 hover:bg-yellow-400/20 focus-visible:ring-yellow-400/70',
    focus: 'focus:border-yellow-400/50',
  },
};

interface Props {
  /** Unique per mounted instance — the input id is derived from it. */
  idPrefix: string;
  accent?: Accent;
  /**
   * Runs after a token is accepted — retry the download, refresh model status.
   * A rejection is surfaced in the field's own error line, so the user sees why
   * the retry failed without leaving the card.
   */
  onSignedIn?: (username: string) => void | Promise<void>;
  className?: string;
}

export const HfTokenField: React.FC<Props> = ({
  idPrefix,
  accent = 'purple',
  onSignedIn,
  className,
}) => {
  const [status, setStatus] = React.useState<HfAuthStatus | null>(null);
  const [token, setToken] = React.useState('');
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAs, setSavedAs] = React.useState<string | null>(null);
  // Set when a signed-in user asks to swap tokens, so the field comes back.
  const [replacing, setReplacing] = React.useState(false);

  const inputId = `${idPrefix}-hf-token`;
  const styles = ACCENTS[accent];
  // An HF_TOKEN env var outranks the stored token both in huggingface_hub and
  // in the backend's own detection, so saving a good token here does NOT undo
  // a stale env var. Say so rather than letting downloads keep failing.
  const envOverride = status?.token_source === 'env';

  React.useEffect(() => {
    let live = true;
    void fetchHfStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    const trimmed = token.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const username = await hfLogin(trimmed);
      setToken('');
      setShow(false);
      setReplacing(false);
      setSavedAs(username);
      setStatus((prev) => ({
        logged_in: true,
        username,
        // Keep the env source if there was one — the warning still applies.
        token_source: prev?.token_source === 'env' ? 'env' : 'stored',
        available: true,
      }));
      try {
        await onSignedIn?.(username);
      } catch (e) {
        setError(e instanceof Error ? `Signed in, but the retry failed: ${e.message}` : 'Signed in, but the retry failed.');
      }
    } catch (e) {
      setError(e instanceof HfAuthError ? e.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const openTokenPage = async () => {
    window.open(await hfLoginUrl(), '_blank', 'noopener');
  };

  // The module is switched off, so no token can be accepted. Point at the one
  // toggle that fixes it instead of showing a field that always fails.
  if (status?.available === false) {
    return (
      <p className={`flex items-start gap-1.5 text-[9px] text-amber-200/90 ${className ?? ''}`}>
        <AlertTriangle className="w-3 h-3 mt-px shrink-0 text-amber-300" />
        <span>Turn on the Hugging Face Auth module in Settings → Modules, then restart theDAW to sign in.</span>
      </p>
    );
  }

  // Already authenticated: say so and get out of the way. "Use another token"
  // reopens the field for the case where this token lacks gated access.
  if (status?.logged_in === true && !replacing) {
    return (
      <div className={`flex flex-col gap-1 ${className ?? ''}`}>
        <div className="flex items-center gap-1.5 text-[9px]">
          <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-300" />
          <span className="min-w-0 truncate text-emerald-200">
            {savedAs ? 'Saved — signed in as ' : 'Signed in as '}
            {status.username ?? 'your account'}
          </span>
          <button
            type="button"
            onClick={() => {
              setReplacing(true);
              setSavedAs(null);
            }}
            className="ml-auto shrink-0 rounded border border-white/10 px-1.5 py-0.5 font-mono uppercase tracking-wider text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
          >
            Use another token
          </button>
        </div>
        {envOverride && <EnvOverrideNote />}
        {error && (
          <p role="alert" className="text-[9px] text-rose-300">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className={`flex flex-col gap-1 ${className ?? ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label
        htmlFor={inputId}
        className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-zinc-300"
      >
        <KeyRound className="w-3 h-3 shrink-0 text-zinc-400" />
        Hugging Face token
      </label>
      <div className="flex gap-1">
        <div className="relative min-w-0 flex-1">
          <input
            id={inputId}
            name={inputId}
            type={show ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="hf_…  paste your token here"
            className={`w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 pr-6 text-[9px] font-mono text-zinc-200 placeholder:text-zinc-500 outline-none ${styles.focus}`}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide token' : 'Show token'}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
        <button
          type="submit"
          disabled={busy || token.trim().length === 0}
          title="Save the token — every download from here on uses it. No restart."
          className={`shrink-0 rounded border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-1 ${styles.button}`}
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
          {busy ? 'Saving' : 'Save'}
        </button>
      </div>
      {envOverride && <EnvOverrideNote />}
      <div className="flex items-center gap-2">
        {error ? (
          <p role="alert" className="min-w-0 flex-1 text-[9px] text-rose-300">
            {error}
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-[9px] text-zinc-500">
            Saved for every download — no restart, nothing else to set up.
          </p>
        )}
        <button
          type="button"
          onClick={() => void openTokenPage()}
          title="Open huggingface.co to mint a token, then paste it above"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        >
          <ExternalLink className="w-2.5 h-2.5 shrink-0" />
          Get a token
        </button>
      </div>
    </form>
  );
};

/** The one failure a correct-looking sign-in can still hide. */
const EnvOverrideNote: React.FC = () => (
  <p className="flex items-start gap-1 text-[9px] text-amber-200/90">
    <AlertTriangle className="w-3 h-3 mt-px shrink-0 text-amber-300" />
    <span>
      An HF_TOKEN environment variable is set and takes priority over anything saved here. If downloads still
      fail, clear it and restart theDAW.
    </span>
  </p>
);

export default HfTokenField;
