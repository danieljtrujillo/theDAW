import React, { useEffect, useState } from 'react';
import { useBootStatusStore } from '../../state/bootStatusStore';

interface BootScreenProps {
  onSkip: () => void;
  onComplete?: () => void;
}

/**
 * The LIGHTWEIGHT boot screen: the same black stage and the same theDAW / by /
 * GANTASMO credit stack as the cinematic ({@link LoadingScreen}), drawn with
 * plain DOM and one preloaded image. No three.js, no WebGL, no GLB, no PMREM
 * bake, no bloom composer.
 *
 * Why this exists: the cinematic is the single most expensive thing in the boot
 * path, and it sits in FRONT of the app — so the boot screen it was supposed to
 * cover could not appear until three.js had parsed, a 1.2 MB model had
 * downloaded, and the GPU had baked an environment map. Everything before that
 * was a black rectangle, which reads as a hang rather than a startup.
 *
 * This screen paints from the same markup the inline `#boot-splash` in
 * index.html already put on screen at first byte, so the handoff from cover to
 * React is invisible — and it holds ONLY as long as the backend actually takes.
 *
 * The cinematic is not gone: flip `BOOT_CINEMATIC` in App.tsx to bring it back.
 */
export const BootScreen: React.FC<BootScreenProps> = ({ onSkip, onComplete }) => {
  const [elapsed, setElapsed] = useState(0);
  const bootStatus = useBootStatusStore((s) => s.status);
  const bootLogs = useBootStatusStore((s) => s.logs);
  const bootError = useBootStatusStore((s) => s.error);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // There is no formation to wait on — the screen is fully drawn on its first
  // frame, so the host is free to hand off the moment the backend is ready.
  useEffect(() => {
    onComplete?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-boot-splash=""
      className="fixed inset-0 z-200 flex select-none flex-col items-center gap-1.5 overflow-hidden bg-black pt-10"
    >
      {/* Same 50vh block the cinematic reserves for the wordmark, so the static
          mark lands in exactly the place the 3D one used to resolve into. */}
      <div className="relative z-10 w-full shrink-0 pointer-events-none" style={{ height: '50vh' }}>
        <span className="absolute inset-0 flex items-end justify-center pb-2 text-4xl font-black uppercase tracking-[0.36em] pl-[0.36em] text-zinc-100">
          theDAW
        </span>
      </div>

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
        }}
      >
        by
      </span>

      {/* Preloaded in index.html's <head>, so it is already decoded here. */}
      <img
        src="/GANTASMO_LOGO.webp"
        alt="GANTASMO"
        className="relative z-10 shrink-0 select-none object-contain"
        draggable={false}
        style={{ height: 'clamp(34px, 8vh, 110px)', maxWidth: '70vw' }}
      />

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
          className="absolute bottom-2 right-3 text-[9px] font-mono text-zinc-700 underline transition-colors hover:text-zinc-400"
        >
          Continue without backend
        </button>
      )}
    </div>
  );
};
