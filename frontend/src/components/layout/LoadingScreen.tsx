import React, { useEffect, useState } from 'react';
import { useStatusBarStore } from '../../state/statusBarStore';

interface LoadingScreenProps {
  onSkip: () => void;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({ onSkip }) => {
  const text = useStatusBarStore((s) => s.text);
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const [elapsed, setElapsed] = useState(0);
  const [dots, setDots] = useState('');

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d.length >= 3 ? '' : d + '.')), 400);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="fixed inset-0 bg-[#07050a] flex flex-col items-center justify-center z-200 select-none">
      {/* Pulsing orb */}
      <div className="relative mb-10 flex items-center justify-center">
        <div className="absolute w-24 h-24 rounded-full bg-purple-600/10 animate-ping" style={{ animationDuration: '2s' }} />
        <div className="absolute w-16 h-16 rounded-full bg-purple-600/15 animate-ping" style={{ animationDuration: '2s', animationDelay: '0.3s' }} />
        <div className="relative w-12 h-12 rounded-full border border-purple-500/40 bg-purple-950/60 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-400 animate-spin" />
          <div className="w-2 h-2 rounded-full bg-purple-400" />
        </div>
      </div>

      {/* App name */}
      <div className="flex flex-col items-center gap-1 mb-8">
        <span className="text-[18px] font-black uppercase tracking-[0.4em] text-zinc-100">theDAW</span>
        <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-600">by GANTASMO · Stable Audio 3</span>
      </div>

      {/* Status */}
      <div className="flex flex-col items-center gap-2">
        <span className="text-[11px] font-mono text-zinc-500 min-w-52 text-center">
          {isBackendReady ? text : `Connecting to backend${dots}`}
        </span>
        <div className="flex items-center gap-2">
          <div className="w-24 h-px bg-zinc-800 relative overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-purple-500/60 transition-all duration-1000"
              style={{ width: `${Math.min(100, (elapsed / 20) * 100)}%` }}
            />
          </div>
          <span className="text-[9px] font-mono text-zinc-700 w-6">{elapsed}s</span>
        </div>
      </div>

      {/* Skip after 15s */}
      {elapsed >= 15 && (
        <button
          onClick={onSkip}
          className="mt-10 text-[9px] font-mono text-zinc-700 hover:text-zinc-400 transition-colors underline"
        >
          Continue without backend
        </button>
      )}
    </div>
  );
};

