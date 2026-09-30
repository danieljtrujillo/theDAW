/**
 * Crash-recovery offer for the EDIT autosave (lib/editorAutosave.ts), plus a
 * one-line notice (T57B) when THIS tab is the `observer` in a two-tab
 * autosave handover — another theDAW window currently owns autosave and
 * this tab writes nothing.
 *
 * TWO SEPARATE top-level fixed layers, not one nested tree. A child's
 * `z-index` only matters within its own parent's stacking context, and a
 * `position: fixed` element with a `z-index` creates one — so nesting the
 * recovery dialog inside the status container would forever paint the whole
 * subtree at the CONTAINER's z, no matter what z-index the dialog itself
 * claimed. That is exactly what hid the recovery offer behind HomeScreen
 * (`components/home/HomeScreen.tsx`, `fixed inset-0 z-60`, opaque, opens on
 * every returning launch by default — `App.tsx`'s post-boot effect) and the
 * boot cinematic (`components/layout/ParticleSplash.tsx`, `fixed inset-0
 * z-200`) once this notice's shared container moved down to z-45.
 *
 *   - Status layer: `z-45`, between the header (`z-40`) and the modal layer
 *     (`z-50` and up) — a non-dismissable ambient notice must never sit over
 *     a modal for the rest of the session.
 *   - Dialog layer: `z-300` — the codebase's existing next full-screen-
 *     overlay tier above the boot cinematic's `z-200` (already used by
 *     `ThemeModal`), so it clears HomeScreen and the boot cinematic, while
 *     staying below the ephemeral utility tier (tooltips / context menus at
 *     `z-9999`/`z-10000`) that legitimately draws over every modal.
 *
 * `pointer-events-none` lives on EACH wrapper — a fixed top-center column
 * still spans width it doesn't visually fill, and that dead space must never
 * swallow a click meant for whatever is under it. The recovery dialog opts
 * back in with `pointer-events-auto`; it has Restore/Discard buttons.
 *
 * The status container — and its `role="status"` node — are ALWAYS
 * rendered, never behind an `offer`/`observer` check: a live region
 * announces a CHANGE to its content, not its own arrival in the DOM, so
 * creating the node only once this tab becomes `observer` would have it
 * already filled the instant it mounts, with nothing to announce. The status
 * node is empty whenever this tab is not `observer`. `role="status"` already
 * implies `aria-live="polite"` per the ARIA spec, so no explicit `aria-live`
 * is set. Only the dialog and the status text are conditional.
 */
import React from 'react';
import { History, Loader2 } from 'lucide-react';
import { useAutosaveRecoveryStore } from '../../lib/editorAutosave';
import { useAppUiStore } from '../../state/appUiStore';

export const AutosaveRecoveryNotice: React.FC = () => {
  const offer = useAutosaveRecoveryStore((s) => s.offer);
  const busy = useAutosaveRecoveryStore((s) => s.busy);
  const restore = useAutosaveRecoveryStore((s) => s.restore);
  const discard = useAutosaveRecoveryStore((s) => s.discard);
  const ownership = useAutosaveRecoveryStore((s) => s.ownership);
  const isObserver = ownership === 'observer';

  const when = offer
    ? (() => {
        const d = new Date(offer.savedAt);
        return Number.isNaN(d.getTime()) ? offer.savedAt : d.toLocaleString();
      })()
    : null;

  return (
    <>
      {offer ? (
        <div className="pointer-events-none fixed left-1/2 top-14 z-300 -translate-x-1/2">
          <div
            role="alertdialog"
            aria-label="Recover autosaved arrangement"
            className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber-500/40 bg-[#0c0a14]/95 px-4 py-2.5 shadow-2xl shadow-amber-900/30 backdrop-blur"
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
              className="flex items-center rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}
      <div className="pointer-events-none fixed left-1/2 top-14 z-45 -translate-x-1/2">
        <div
          role="status"
          className={
            isObserver
              ? 'rounded-lg border border-white/10 bg-[#0c0a14]/95 px-3 py-1.5 text-[10px] font-mono text-zinc-400 shadow-xl backdrop-blur'
              : 'sr-only'
          }
        >
          {isObserver ? 'Autosave is running in another theDAW tab — changes here are not autosaved.' : ''}
        </div>
      </div>
    </>
  );
};
