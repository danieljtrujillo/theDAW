import React, { useEffect, useState } from 'react';
import { LiquidChromeTitle } from './LiquidChromeTitle';

interface LoadingScreenProps {
  onSkip: () => void;
  onComplete?: () => void;
}

/**
 * The boot screen IS the cinematic — the liquid-chrome theDAW model pouring in
 * over a dark purple steel field, "by GANTASMO" forming from electricity
 * beneath it. No labels, never says "loading". If WebGL doesn't start, it falls
 * back to static branding (and reports complete so the host doesn't hang). A
 * tiny "continue without backend" escape appears only after a genuinely long
 * wait.
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({ onSkip, onComplete }) => {
  const [elapsed, setElapsed] = useState(0);
  const [cinematicActive, setCinematicActive] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // If WebGL never started there is no formation to wait on — report complete so
  // the host hands off the moment the backend is ready.
  useEffect(() => {
    if (cinematicActive === false && elapsed >= 1) onComplete?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cinematicActive, elapsed]);

  return (
    <div className="fixed inset-0 z-200 select-none overflow-hidden bg-[radial-gradient(120%_120%_at_50%_42%,#241640_0%,#160e28_55%,#0d0818_100%)]">
      {/* Liquid-chrome cinematic (the whole screen). */}
      <LiquidChromeTitle onActive={setCinematicActive} onComplete={onComplete} />

      {/* Static fallback ONLY if WebGL genuinely never starts. The 3s grace stops
          it from flashing in during the brief gap before the cinematic's first
          frame (which previously showed the flat branding for a beat at startup). */}
      {!cinematicActive && elapsed >= 3 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <span className="text-3xl font-black uppercase tracking-[0.36em] pl-[0.36em] text-zinc-100">
            theDAW
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.4em] text-zinc-600">by GANTASMO</span>
        </div>
      )}

      {/* Real escape only after a genuine wait. */}
      {elapsed >= 40 && (
        <button
          onClick={onSkip}
          className="absolute bottom-2 right-3 text-[9px] font-mono text-zinc-700 hover:text-zinc-400 transition-colors underline"
        >
          Continue without backend
        </button>
      )}
    </div>
  );
};
