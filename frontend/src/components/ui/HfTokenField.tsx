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
 * Call sites: Settings → Models (Hugging Face row, `compact`), the DownloadDock
 * error block (gated / rate-limited downloads), and the feature-gate notice
 * stack. `idPrefix` keeps the input id unique when two of these are on screen
 * at once. `compact` renders the whole thing on ONE row: label, status or
 * input, reveal toggle for the secret, Save, Get a token — the helper copy
 * moves into hover titles.
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { fetchHfStatus, hfLogin, hfLoginUrl, HfAuthError, type HfAuthStatus } from '../../lib/hfAuthClient';
import { SECRET_ICON_CLASS, SecretFieldLabel } from './SecretFieldLabel';

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

const ENV_OVERRIDE_TEXT =
  'An HF_TOKEN environment variable is set and takes priority over anything saved here. If downloads still fail, clear it and restart theDAW.';
const SAVED_HELP = 'Saved for every download — no restart, nothing else to set up.';

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
  /** One-row layout for dense panels (Settings). */
  compact?: boolean;
}

export const HfTokenField: React.FC<Props> = ({
  idPrefix,
  accent = 'purple',
  onSignedIn,
  className,
  compact = false,
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
  const text = compact ? 'text-[11px]' : 'text-[9px]';
  // The status call itself failed — fetchHfStatus never throws for this; it
  // reports the failure in `status.error` precisely so a dead backend is
  // distinguishable from "not signed in" (see hfAuthClient.ts). Read it here
  // so that distinction actually reaches the user instead of being dropped on
  // the floor, which left this field rendering an ordinary "paste your token"
  // form during a backend outage with no explanation for why sign-in status
  // was unknown.
  const statusError = status?.error?.message ?? null;

  // Bumped whenever something more authoritative than an in-flight status
  // check writes status — a successful save() — so a status check that
  // started earlier and settles later cannot clobber it. This is NOT
  // redundant with the `live` flags below: those only go false once React
  // actually runs the effect's cleanup, which happens on its own schedule
  // relative to a state update; this ref is bumped synchronously, inside
  // save() itself, the instant login succeeds, with no render or effect-flush
  // in between. A slow status check's own multi-hop promise chain (reading
  // the response body, formatting a hop-aware error message) can easily still
  // be unwinding at that exact moment and land its `setStatus` AFTER save()'s,
  // transiently — or, depending on timing, permanently — resurrecting the
  // error alert over a session the user just successfully signed in to.
  const statusGenRef = React.useRef(0);

  React.useEffect(() => {
    let live = true;
    const startGen = statusGenRef.current;
    void fetchHfStatus().then((s) => {
      if (live && statusGenRef.current === startGen) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);

  // While the status check is failing, re-ask on window focus — the user
  // alt-tabbing back after restarting theDAW is exactly this moment — and
  // clear the alert on its own once the backend answers healthy again, no
  // manual retry and no remount needed. Nothing to listen for once the error
  // clears (the effect re-runs and skips registering).
  React.useEffect(() => {
    if (!statusError) return;
    let live = true;
    const onFocus = () => {
      const startGen = statusGenRef.current;
      void fetchHfStatus().then((s) => {
        if (live && statusGenRef.current === startGen) setStatus(s);
      });
    };
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [statusError]);

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
      // Bump BEFORE writing status: any status check already in flight
      // (mount, or a focus refetch) is now stale and must ignore its own
      // result when it settles, however long that takes.
      statusGenRef.current += 1;
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
      <p className={`flex items-start gap-1.5 ${text} text-amber-200/90 ${className ?? ''}`}>
        <AlertTriangle className="w-3 h-3 mt-px shrink-0 text-amber-300" />
        <span className={compact ? 'truncate' : ''}>
          Turn on the Hugging Face Auth module in Settings → Modules, then restart theDAW to sign in.
        </span>
      </p>
    );
  }

  // Already authenticated: say so and get out of the way. "Use another token"
  // reopens the field for the case where this token lacks gated access.
  if (status?.logged_in === true && !replacing) {
    return (
      <div className={`flex ${compact ? 'items-center gap-2' : 'flex-col gap-1'} ${className ?? ''}`}>
        <div className={`flex items-center gap-1.5 ${text} min-w-0 flex-1`}>
          {/* The key glyph identifies the row in BOTH layouts — the same field
              must not introduce itself differently depending on its host. */}
          <KeyRound className={SECRET_ICON_CLASS} aria-hidden="true" />
          {compact && <span className="shrink-0 font-mono uppercase tracking-wider text-zinc-300">Hugging Face</span>}
          <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-300" />
          <span className="min-w-0 truncate text-emerald-200" title={envOverride ? ENV_OVERRIDE_TEXT : undefined}>
            {savedAs ? 'Saved — signed in as ' : 'Signed in as '}
            {status.username ?? 'your account'}
            {compact && envOverride ? ' · HF_TOKEN env var wins' : ''}
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
        {!compact && envOverride && <EnvOverrideNote />}
        {error && (
          <p role="alert" className={`${text} text-rose-300 ${compact ? 'truncate max-w-64' : ''}`} title={error}>
            {error}
          </p>
        )}
      </div>
    );
  }

  const input = (
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
        title={compact ? SAVED_HELP : undefined}
        className={`w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 pr-6 ${text} font-mono text-zinc-200 placeholder:text-zinc-500 outline-none ${styles.focus}`}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Hide token' : 'Show token'}
        aria-pressed={show}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
      >
        {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </button>
    </div>
  );
  const saveButton = (
    <button
      type="submit"
      disabled={busy || token.trim().length === 0}
      title="Save the token — every download from here on uses it. No restart."
      className={`shrink-0 rounded border px-2 py-1 ${text} font-black uppercase tracking-widest transition-colors disabled:opacity-40 inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-1 ${styles.button}`}
    >
      {busy && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
      {busy ? 'Saving' : 'Save'}
    </button>
  );
  const getTokenButton = (
    <button
      type="button"
      onClick={() => void openTokenPage()}
      title="Open huggingface.co to mint a token, then paste it here"
      className={`inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 ${text} font-mono uppercase tracking-wider text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30`}
    >
      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
      Get a token
    </button>
  );

  if (compact) {
    return (
      <form
        className={`flex items-center gap-1.5 ${className ?? ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SecretFieldLabel
          htmlFor={inputId}
          title={`${SAVED_HELP}${envOverride ? ` ${ENV_OVERRIDE_TEXT}` : ''}`}
          className={`shrink-0 ${text} font-mono uppercase tracking-wider text-zinc-300`}
        >
          Hugging Face
        </SecretFieldLabel>
        {input}
        {saveButton}
        {getTokenButton}
        {envOverride && (
          <span className={`shrink-0 ${text} text-amber-300`} title={ENV_OVERRIDE_TEXT}>
            <AlertTriangle className="w-3 h-3" aria-label="HF_TOKEN environment variable takes priority" />
          </span>
        )}
        {statusError && !error && (
          <span role="alert" className={`shrink-0 ${text} text-rose-300`} title={statusError}>
            <AlertTriangle className="w-3 h-3" role="img" aria-label="Could not check sign-in status" />
            {/* The icon's aria-label is a fixed summary, not the actual reason
                (a backend-down sentence vs. a Hub-rejected one, say) — a
                screen reader user gets the same specific text a sighted user
                reads from the title tooltip, not just "could not check". */}
            <span className="sr-only">{statusError}</span>
          </span>
        )}
        {error && (
          <p role="alert" className={`min-w-0 truncate ${text} text-rose-300`} title={error}>
            {error}
          </p>
        )}
      </form>
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
      <SecretFieldLabel
        htmlFor={inputId}
        className="text-[9px] font-mono uppercase tracking-wider text-zinc-300"
      >
        Hugging Face token
      </SecretFieldLabel>
      <div className="flex gap-1">
        {input}
        {saveButton}
      </div>
      {envOverride && <EnvOverrideNote />}
      <div className="flex items-center gap-2">
        {error ? (
          <p role="alert" className="min-w-0 flex-1 text-[9px] text-rose-300">
            {error}
          </p>
        ) : statusError ? (
          <p role="alert" className="min-w-0 flex-1 text-[9px] text-rose-300">
            {statusError}
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-[9px] text-zinc-500">{SAVED_HELP}</p>
        )}
        {getTokenButton}
      </div>
    </form>
  );
};

/** The one failure a correct-looking sign-in can still hide. */
const EnvOverrideNote: React.FC = () => (
  <p className="flex items-start gap-1 text-[9px] text-amber-200/90">
    <AlertTriangle className="w-3 h-3 mt-px shrink-0 text-amber-300" />
    <span>{ENV_OVERRIDE_TEXT}</span>
  </p>
);

export default HfTokenField;
