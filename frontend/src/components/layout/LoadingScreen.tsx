import React, { useEffect, useState } from 'react';
import { LiquidChromeTitle } from './LiquidChromeTitle';
import { useBootStatusStore } from '../../state/bootStatusStore';

interface LoadingScreenProps {
  onSkip: () => void;
  onComplete?: () => void;
}

/**
 * The boot screen IS the cinematic. A solid BLACK background fills the whole
 * screen (the one continuous backdrop from the first frame after boot through to
 * the app — matches index.html's splash + the Electron window). A full-bleed
 * stack sits on it: the liquid-chrome theDAW model (~2.5x the logo), a small
 * 3D-ish "by", and the animated GANTASMO logo. No labels, never says "loading".
 * If WebGL doesn't start, the model area falls back to static branding (and
 * reports complete so the host doesn't hang). A tiny "continue without backend"
 * escape appears only after a genuinely long wait.
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({ onSkip, onComplete }) => {
  const [elapsed, setElapsed] = useState(0);
  const [cinematicActive, setCinematicActive] = useState(false);
  // "by" and the GANTASMO logo are held back until the theDAW wordmark has
  // actually resolved out of the goo, so the three credits land in order:
  // theDAW, then by, then GANTASMO. They used to run on fixed 1.6s/2.0s timers
  // and so appeared while the wordmark was still assembling.
  const [formed, setFormed] = useState(false);
  const bootStatus = useBootStatusStore((s) => s.status);
  const bootLogs = useBootStatusStore((s) => s.logs);
  const bootError = useBootStatusStore((s) => s.error);

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

  // Same fallback for the credit reveal: with no WebGL there is no formation to
  // wait on, so release "by"/GANTASMO on the static branding instead of leaving
  // the boot screen showing a lone wordmark forever.
  useEffect(() => {
    if (!cinematicActive && elapsed >= 2 && !formed) setFormed(true);
  }, [cinematicActive, elapsed, formed]);

  // data-boot-splash is a stable hook for the capture harness / tests to wait on.
  // Keyed off the attribute rather than the wordmark: the old text-based check broke
  // silently when the splash was rebranded, and let the splash bleed into every clip.
  return (
    <div data-boot-splash="" className="fixed inset-0 z-200 select-none overflow-hidden bg-black flex flex-col items-center gap-1.5 pt-10">
      <style>{`@keyframes bootCreditFade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>

      {/* The cinematic canvas is FULL-BLEED behind everything, so the black goo
          sheet covers the entire window instead of just the wordmark's layout
          box. The credits below sit on top of it (z-10) and the 50vh block is
          now only a spacer reserving the area the 3D wordmark renders into. */}
      <LiquidChromeTitle
        className="absolute inset-0 block h-full w-full"
        onActive={setCinematicActive}
        onComplete={onComplete}
        onFormed={() => setFormed(true)}
      />

      <div className="relative z-10 w-full shrink-0 pointer-events-none" style={{ height: '50vh' }}>
        {/* Static fallback ONLY if WebGL never starts (model can't render). */}
        {!cinematicActive && elapsed >= 3 && (
          <span className="absolute inset-0 flex items-end justify-center pb-2 text-4xl font-black uppercase tracking-[0.36em] pl-[0.36em] text-zinc-100">
            theDAW
          </span>
        )}
      </div>

      {/* by — small, 3D-ish chrome lettering. Mounted only once the wordmark has
          formed, so its fade-in actually plays at the moment of reveal (a
          visibility toggle would let the animation finish while still hidden). */}
      {formed && (
      <span
        className="relative z-10"
        style={{
          fontFamily: "'Orbitron', system-ui, sans-serif",
          fontWeight: 700,
          letterSpacing: '0.18em',
          fontSize: 'clamp(11px, 2.2vh, 24px)',
          backgroundImage:
            'linear-gradient(180deg,#ffffff 0%,#cbb9e8 46%,#7a6aa0 56%,#efe9fb 100%)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
          textShadow: '0 1px 0 rgba(255,255,255,0.18), 0 3px 6px rgba(0,0,0,0.6)',
          // Delays are now relative to the wordmark resolving, not to page load.
          animation: 'bootCreditFade 0.9s ease 0.05s both',
        }}
      >
        by
      </span>
      )}

      {/* GANTASMO — the animated logo, ~30% size, tight under "by". Comes in
          after "by", completing the theDAW -> by -> GANTASMO order. */}
      {formed && (
        <img
          src="/GANTASMO_LOGO.webp"
          alt="GANTASMO"
          className="relative z-10 shrink-0 object-contain select-none"
          draggable={false}
          style={{
            height: 'clamp(34px, 8vh, 110px)',
            maxWidth: '70vw',
            animation: 'bootCreditFade 1.1s ease 0.75s both',
          }}
        />
      )}

      {/* First-run bootstrap status, so a slow or failed setup is visible
          instead of a silent hang. Low-key under the logo; errors stand out. */}
      {(bootError || ((bootStatus || bootLogs.length > 0) && elapsed >= 3)) && (
        <div className="absolute inset-x-0 bottom-9 flex flex-col items-center gap-1 px-6 text-center">
          {bootError ? (
            <div className="max-w-xl text-[11px] font-mono leading-relaxed text-red-300/90">
              Setup error: {bootError}
            </div>
          ) : (
            <>
              {bootStatus && (
                <div className="text-[11px] font-mono tracking-wide text-zinc-400">{bootStatus}</div>
              )}
              {bootLogs.length > 0 && (
                <div className="max-w-xl truncate text-[9px] font-mono text-zinc-600">
                  {bootLogs[bootLogs.length - 1]}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Real escape after a genuine wait, or immediately on a setup error. */}
      {(elapsed >= 40 || bootError) && (
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
