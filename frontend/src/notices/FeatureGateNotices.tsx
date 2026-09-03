/**
 * FeatureGateNotices — bottom-right stack of "capability missing" cards.
 *
 * Renders the featureGateStore queue: newest card nearest the corner, at most
 * three visible, older ones collapsed into a "+N more" chip. Module/model
 * gates get an amber left edge plus an optional primary action button; the
 * 'hf' kind renders the shared <HfTokenField /> inline, so the card that says
 * "you need a token" is also where the token goes in. On a successful sign-in
 * the notice's own action runs as the retry, then the card dismisses itself.
 * 'progress' cards (an engine being started for the user) spin and update in
 * place; 'error' cards (a save that was rolled back) carry a Retry button.
 * Nothing polls here — every network request is user-initiated or owned by
 * the client that raised the progress card.
 *
 * Coexistence with DownloadDock (same corner, default bottom-28 right-4):
 * while download jobs exist this stack lifts to bottom-44 so the collapsed
 * dock pill and the notice cards never overlap.
 */
import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, KeyRound, Loader2, X } from 'lucide-react';
import { useDownloadStore } from '../state/downloadStore';
import { HfTokenField } from '../components/ui/HfTokenField';
import { useFeatureGateStore, type FeatureGateKind, type FeatureGateNotice } from './featureGateStore';

const MAX_VISIBLE = 3;

interface KindStyle {
  card: string;
  icon: string;
  title: string;
  button: string;
  Icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
}

const AMBER_BUTTON =
  'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100 focus-visible:ring-amber-400/70';

const KIND_STYLES: Record<FeatureGateKind, KindStyle> = {
  module: {
    card: 'border-white/10 border-l-2 border-l-amber-400/80',
    icon: 'text-amber-300',
    title: 'text-amber-200',
    button: AMBER_BUTTON,
    Icon: AlertTriangle,
  },
  model: {
    card: 'border-white/10 border-l-2 border-l-amber-400/80',
    icon: 'text-amber-300',
    title: 'text-amber-200',
    button: AMBER_BUTTON,
    Icon: AlertTriangle,
  },
  hf: {
    card: 'border-yellow-500/25 border-l-2 border-l-yellow-400/80',
    icon: 'text-yellow-300',
    title: 'text-yellow-200',
    button: AMBER_BUTTON,
    Icon: KeyRound,
  },
  progress: {
    card: 'border-sky-500/25 border-l-2 border-l-sky-400/80',
    icon: 'text-sky-300',
    title: 'text-sky-200',
    button:
      'border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 hover:text-sky-100 focus-visible:ring-sky-400/70',
    Icon: Loader2,
    spin: true,
  },
  error: {
    card: 'border-rose-500/30 border-l-2 border-l-rose-400/80',
    icon: 'text-rose-300',
    title: 'text-rose-200',
    button:
      'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100 focus-visible:ring-rose-400/70',
    Icon: AlertCircle,
  },
  success: {
    card: 'border-emerald-500/25 border-l-2 border-l-emerald-400/80',
    icon: 'text-emerald-300',
    title: 'text-emerald-200',
    button:
      'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 focus-visible:ring-emerald-400/70',
    Icon: CheckCircle2,
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
  const [signedIn, setSignedIn] = React.useState(false);

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

  // A successful sign-in already ran the retry; leave the confirmation up long
  // enough to read, then clear the card the user has finished with.
  React.useEffect(() => {
    if (!signedIn) return;
    const timer = window.setTimeout(() => dismiss(notice.id), 4000);
    return () => window.clearTimeout(timer);
  }, [signedIn, dismiss, notice.id]);

  return (
    <div
      role={notice.kind === 'error' ? 'alert' : notice.kind === 'progress' ? 'status' : undefined}
      className={`pointer-events-auto w-full rounded-lg border bg-[#0a080f]/95 shadow-[0_8px_32px_rgba(0,0,0,0.75)] backdrop-blur-md ${style.card}`}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <Icon className={`w-3.5 h-3.5 mt-px shrink-0 ${style.icon} ${style.spin ? 'animate-spin' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className={`text-[10px] font-black uppercase tracking-widest ${style.title}`}>
            {notice.title}
          </div>
          {/* Clamped, not truncated: these messages are the instructions for
              the control right below them, and a one-line ellipsis throws the
              instruction away. The title still carries the full text. */}
          <p
            className="mt-0.5 text-[10px] leading-snug text-zinc-400 line-clamp-3"
            title={notice.message}
          >
            {notice.message}
          </p>
          {notice.docsHint && (
            <p className="mt-0.5 text-[8px] font-mono uppercase tracking-wider text-zinc-600 truncate">
              {notice.docsHint}
            </p>
          )}
          {notice.kind === 'hf' ? (
            // The token goes in right here. `notice.action` is the retry — it
            // runs on a good token instead of needing a second click, and a
            // throw surfaces inside the field rather than losing the card.
            <HfTokenField
              idPrefix={`gate-${notice.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
              accent="yellow"
              className="mt-1.5"
              onSignedIn={async () => {
                if (notice.action) await notice.action.run();
                setSignedIn(true);
              }}
            />
          ) : (
            notice.action && (
              <button
                type="button"
                onClick={() => void runAction()}
                disabled={running}
                className={`mt-1.5 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[9px] font-black uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:opacity-50 ${style.button}`}
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

export default FeatureGateNotices;
