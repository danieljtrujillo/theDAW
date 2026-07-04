/**
 * FeatureGateNotices — bottom-right stack of "capability missing" cards.
 *
 * Renders the featureGateStore queue: newest card nearest the corner, at most
 * three visible, older ones collapsed into a "+N more" chip. Module/model
 * gates get an amber left edge plus an optional primary action button; the
 * 'hf' kind renders an inline Hugging Face token sign-in against /api/hfauth.
 * Nothing polls here — every network request is user-initiated.
 *
 * Coexistence with DownloadDock (same corner, default bottom-28 right-4):
 * while download jobs exist this stack lifts to bottom-44 so the collapsed
 * dock pill and the notice cards never overlap.
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, Loader2, X } from 'lucide-react';
import { useDownloadStore } from '../state/downloadStore';
import { useFeatureGateStore, type FeatureGateKind, type FeatureGateNotice } from './featureGateStore';

const MAX_VISIBLE = 3;

interface KindStyle {
  card: string;
  icon: string;
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const KIND_STYLES: Record<FeatureGateKind, KindStyle> = {
  module: {
    card: 'border-white/10 border-l-2 border-l-amber-400/80',
    icon: 'text-amber-300',
    title: 'text-amber-200',
    Icon: AlertTriangle,
  },
  model: {
    card: 'border-white/10 border-l-2 border-l-amber-400/80',
    icon: 'text-amber-300',
    title: 'text-amber-200',
    Icon: AlertTriangle,
  },
  hf: {
    card: 'border-yellow-500/25 border-l-2 border-l-yellow-400/80',
    icon: 'text-yellow-300',
    title: 'text-yellow-200',
    Icon: KeyRound,
  },
};

export const FeatureGateNotices: React.FC = () => {
  const notices = useFeatureGateStore((s) => s.notices);
  // DownloadDock rests at bottom-28 right-4 whenever jobs exist; lift above it.
  const dockPresent = useDownloadStore((s) => s.jobs.length > 0);

  if (notices.length === 0) return null;

  const visible = notices.slice(-MAX_VISIBLE);
  const hiddenCount = notices.length - visible.length;
  const hiddenTitles = notices
    .slice(0, hiddenCount)
    .map((n) => n.title)
    .join(', ');

  return (
    <div
      aria-live="polite"
      className={`fixed right-4 ${dockPresent ? 'bottom-44' : 'bottom-28'} z-50 flex w-80 max-w-[92vw] flex-col items-end gap-2 pointer-events-none`}
    >
      {hiddenCount > 0 && (
        <div
          title={hiddenTitles}
          className="pointer-events-auto rounded-full border border-white/10 bg-[#0a080f]/95 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-500 backdrop-blur-md"
        >
          +{hiddenCount} more
        </div>
      )}
      {visible.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
};

const NoticeCard: React.FC<{ notice: FeatureGateNotice }> = ({ notice }) => {
  const dismiss = useFeatureGateStore((s) => s.dismiss);
  const style = KIND_STYLES[notice.kind];
  const { Icon } = style;
  const [running, setRunning] = React.useState(false);

  const runAction = async () => {
    if (!notice.action || running) return;
    setRunning(true);
    try {
      await notice.action.run();
      dismiss(notice.id);
    } catch {
      // Keep the card so the action can be retried.
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className={`pointer-events-auto w-full rounded-lg border bg-[#0a080f]/95 shadow-[0_8px_32px_rgba(0,0,0,0.75)] backdrop-blur-md ${style.card}`}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <Icon className={`w-3.5 h-3.5 mt-px shrink-0 ${style.icon}`} />
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-black uppercase tracking-widest ${style.title}`}>
            {notice.title}
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-zinc-400 truncate" title={notice.message}>
            {notice.message}
          </p>
          {notice.docsHint && (
            <p className="mt-0.5 text-[8px] font-mono uppercase tracking-wider text-zinc-600 truncate">
              {notice.docsHint}
            </p>
          )}
          {notice.kind === 'hf' ? (
            <HfSignIn notice={notice} onDismiss={() => dismiss(notice.id)} />
          ) : (
            notice.action && (
              <button
                type="button"
                onClick={() => void runAction()}
                disabled={running}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-amber-200 hover:bg-amber-500/20 hover:text-amber-100 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70 disabled:opacity-50"
              >
                {running && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
                {notice.action.label}
              </button>
            )
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(notice.id)}
          aria-label={`Dismiss ${notice.title}`}
          className="p-1 -m-0.5 rounded text-zinc-500 hover:bg-white/5 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};

/**
 * Inline Hugging Face token flow for kind 'hf'. Posts the token to
 * /api/hfauth/login on submit; a 401 shows an inline rejection message. The
 * secondary button fetches /api/hfauth/login-url and opens it in a new tab.
 * On success the body swaps to "Signed in as <username>" and the card
 * auto-dismisses after 4 seconds.
 */
const HfSignIn: React.FC<{ notice: FeatureGateNotice; onDismiss: () => void }> = ({
  notice,
  onDismiss,
}) => {
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [signedInAs, setSignedInAs] = React.useState<string | null>(null);
  const inputId = `hf-token-${notice.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;

  React.useEffect(() => {
    if (!signedInAs) return;
    const timer = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(timer);
  }, [signedInAs, onDismiss]);

  const submit = async () => {
    const trimmed = token.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/hfauth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: trimmed }),
      });
      if (res.status === 401) {
        setError('Token rejected. Check it and try again.');
        return;
      }
      if (!res.ok) {
        setError(`Sign-in failed (HTTP ${res.status}).`);
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      const rec = (data ?? {}) as Record<string, unknown>;
      const username =
        typeof rec.username === 'string' && rec.username
          ? rec.username
          : typeof rec.name === 'string' && rec.name
            ? rec.name
            : 'Hugging Face user';
      setSignedInAs(username);
    } catch {
      setError('Could not reach the backend.');
    } finally {
      setBusy(false);
    }
  };

  const openHf = async () => {
    let url = 'https://huggingface.co/settings/tokens';
    try {
      const res = await fetch('/api/hfauth/login-url');
      if (res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const rec = (data ?? {}) as Record<string, unknown>;
        if (typeof rec.url === 'string' && rec.url) url = rec.url;
        else if (typeof rec.login_url === 'string' && rec.login_url) url = rec.login_url;
      }
    } catch {
      // Fall through to the default token page.
    }
    window.open(url, '_blank', 'noopener');
  };

  if (signedInAs) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-emerald-300">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">Signed in as {signedInAs}</span>
      </div>
    );
  }

  return (
    <form
      className="mt-1.5 flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label
        htmlFor={inputId}
        className="text-[8px] font-mono uppercase tracking-widest text-zinc-500"
      >
        Hugging Face token
      </label>
      <input
        id={inputId}
        name="hf-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="hf_..."
        className="w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-[10px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-yellow-400/50"
      />
      {error && (
        <p role="alert" className="text-[9px] text-rose-300">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={busy || token.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded border border-yellow-400/40 bg-yellow-400/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-yellow-200 hover:bg-yellow-400/20 hover:text-yellow-100 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-yellow-400/70 disabled:opacity-50"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
          Sign in
        </button>
        <button
          type="button"
          onClick={() => void openHf()}
          className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        >
          <ExternalLink className="w-3 h-3 shrink-0" />
          Open huggingface.co
        </button>
      </div>
    </form>
  );
};

export default FeatureGateNotices;
