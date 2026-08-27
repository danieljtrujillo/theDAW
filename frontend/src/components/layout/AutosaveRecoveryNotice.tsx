/**
 * Crash-recovery offer for the EDIT autosave (lib/editorAutosave.ts).
 *
 * Shown top-center under the header when an autosaved arrangement exists at
 * startup. Autosaving stays PAUSED until the user answers, so a stray startup
 * edit can never overwrite the only copy of crashed work — which is also why
 * this notice does not auto-dismiss.
 */
import React from 'react';
import { History, Loader2, Trash2 } from 'lucide-react';
import { useAutosaveRecoveryStore } from '../../lib/editorAutosave';
import { useAppUiStore } from '../../state/appUiStore';

export const AutosaveRecoveryNotice: React.FC = () => {
  const offer = useAutosaveRecoveryStore((s) => s.offer);
  const busy = useAutosaveRecoveryStore((s) => s.busy);
  const restore = useAutosaveRecoveryStore((s) => s.restore);
  const discard = useAutosaveRecoveryStore((s) => s.discard);

  if (!offer) return null;

  const when = (() => {
    const d = new Date(offer.savedAt);
    return Number.isNaN(d.getTime()) ? offer.savedAt : d.toLocaleString();
  })();

  return (
    <div className="fixed left-1/2 top-14 z-100 -translate-x-1/2">
      <div
        role="alertdialog"
        aria-label="Recover autosaved arrangement"
        className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-[#0c0a14]/95 px-4 py-2.5 shadow-2xl shadow-amber-900/30 backdrop-blur"
      >
        <History className="h-4 w-4 shrink-0 text-amber-300" />
        <div className="flex flex-col leading-tight">
          <span className="text-[11px] font-bold text-amber-100">
            Unsaved arrangement recovered
          </span>
          <span className="text-[9px] font-mono text-zinc-400">
            {offer.trackCount} track(s), {offer.clipCount} clip(s) · autosaved {when}
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void restore().then(() => {
              // Land the user on the restored work.
              useAppUiStore.getState().navigateTo('edit');
            });
          }}
          className="ml-2 flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Restore
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void discard()}
          className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" />
          Discard
        </button>
      </div>
    </div>
  );
};
