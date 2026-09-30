/**
 * The one place the app explains that audio processing is off, and what to do
 * about it, BEFORE anything tries to load a worklet and crashes.
 *
 * `BaseAudioContext.audioWorklet` is secure-context-only, so opening theDAW
 * from another machine over plain http (`http://192.168.1.34:5174`) leaves it
 * `undefined` and every worklet load fails. That used to surface as a generic
 * "Cannot read properties of undefined (reading 'addModule')" crash card with
 * an unusable Retry button. `lib/audioWorkletSupport.ts` decides whether this
 * page has the problem; this renders the answer.
 *
 * Shape follows `AutosaveRecoveryNotice`: a fixed top-center pill on the status
 * layer (`z-45`, between the header at `z-40` and the modal layer at `z-50`),
 * `pointer-events-none` on the wrapper so the width it does not visually fill
 * never eats a click, `pointer-events-auto` on the pill itself because it has a
 * Dismiss button. It sits at `top-24` rather than `top-14` so it never covers
 * the autosave notice, which owns that slot.
 *
 * `role="status"`, as that precedent uses for its ambient line: this is a
 * standing condition of the page, not an interruption. Dismissal is remembered
 * in `sessionStorage` — the condition is a property of THIS address, so a new
 * session (a new tab, or the same tab opened on a different origin) gets told
 * again, while clicking away does not nag for the rest of this one.
 */
import React from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { describeAudioWorkletProblem, type AudioWorkletEnv } from '../../lib/audioWorkletSupport';

export const AUDIO_WORKLET_NOTICE_DISMISS_KEY = 'thedaw.audioWorkletNotice.dismissed';

/** sessionStorage throws outright in some privacy modes; a notice must never
 *  be the thing that takes the app down. */
const readDismissed = (): boolean => {
  try {
    return globalThis.sessionStorage?.getItem(AUDIO_WORKLET_NOTICE_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberDismissed = (): void => {
  try {
    globalThis.sessionStorage?.setItem(AUDIO_WORKLET_NOTICE_DISMISS_KEY, '1');
  } catch {
    /* nothing to remember it in; the notice still closes for this render */
  }
};

interface AudioWorkletUnavailableNoticeProps {
  /** Globals to read instead of the real ones. Tests only. */
  env?: AudioWorkletEnv;
  /**
   * The LAN https address this machine also serves the app on, from
   * `GET /api/network/lan` (Shell). When present the notice names it, which
   * turns "arrange a secure context somehow" into one address to open. It
   * arrives asynchronously, after this component has already mounted and told
   * the user the generic version, so the text is re-derived when it lands.
   */
  secureUrl?: string | null;
}

export const AudioWorkletUnavailableNotice: React.FC<AudioWorkletUnavailableNoticeProps> = ({
  env,
  secureUrl,
}) => {
  // The page's secure-context status cannot change without a navigation, so
  // the DIAGNOSIS is stable; only the address we can offer as the cure moves.
  const problem = React.useMemo(() => describeAudioWorkletProblem(env, secureUrl), [env, secureUrl]);
  const [dismissed, setDismissed] = React.useState(readDismissed);

  if (!problem || dismissed) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-24 z-45 -translate-x-1/2">
      <div
        role="status"
        className="pointer-events-auto flex max-w-[min(560px,92vw)] items-start gap-3 rounded-lg border border-amber-500/40 bg-[#0c0a14]/95 px-4 py-2.5 shadow-2xl shadow-amber-900/30 backdrop-blur"
      >
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="flex flex-col gap-1 leading-tight">
          <span className="text-[11px] font-bold text-amber-100">{problem.title}</span>
          <span className="text-[9px] font-mono text-zinc-400">{problem.detail}</span>
        </div>
        <button
          type="button"
          aria-label="Dismiss the audio support notice"
          onClick={() => {
            rememberDismissed();
            setDismissed(true);
          }}
          className="ml-1 flex shrink-0 items-center rounded border border-white/10 bg-white/5 p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};
