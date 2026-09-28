import React, { useState, useRef, useCallback } from 'react';
import { TAP_MAX_INTERVAL_MS, tapTempoBpm } from './tapTempo';

interface BpmTapperProps {
  onBpmSet: (bpm: number) => void;
  currentBpm: number;
}

/** Tap tempo, drawn in the MIDI dock's key grammar: the theme accent while
 *  taps are landing, no glow. */
export const BpmTapper: React.FC<BpmTapperProps> = ({ onBpmSet, currentBpm }) => {
  const [taps, setTaps] = useState<number[]>([]);
  const [calculatedBpm, setCalculatedBpm] = useState<number | null>(null);
  const [isActive, setIsActive] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // The app's 20-300 BPM (tapTempo.ts): an interval outside it is an outlier and is left out.
  const calculateBpm = useCallback((tapTimes: number[]): number | null => tapTempoBpm(tapTimes), []);

  const handleTap = useCallback(() => {
    const now = performance.now();

    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    setTaps(prevTaps => {
      // Just add the new tap (no auto-reset, user must click Reset)
      const newTaps = [...prevTaps, now];

      // Keep only last 10 taps for rolling average
      const trimmedTaps = newTaps.slice(-10);

      // Calculate BPM
      const bpm = calculateBpm(trimmedTaps);
      setCalculatedBpm(bpm);
      setIsActive(true);

      return trimmedTaps;
    });

    // Auto-pause (not reset) once a beat at the slowest tempo (3 s at 20 BPM) and a half second pass
    // with no tap, so taps at a Grave keep the key lit between them.
    timeoutRef.current = setTimeout(() => {
      setIsActive(false);
    }, TAP_MAX_INTERVAL_MS + 500);
  }, [calculateBpm]);

  const handleReset = useCallback(() => {
    setTaps([]);
    setCalculatedBpm(null);
    setIsActive(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  }, []);

  const handleApply = useCallback(() => {
    if (calculatedBpm) {
      onBpmSet(calculatedBpm);
    }
  }, [calculatedBpm, onBpmSet]);

  const lift = 'shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xs p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[12px] font-display font-bold et-ink-3 uppercase">Tap Tempo</h3>
        {calculatedBpm && (
          <button
            type="button"
            onClick={handleReset}
            className="text-[12px] font-semibold et-ink-3 hover:et-ink transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* Tap Button */}
      <button
        type="button"
        onClick={handleTap}
        aria-label={calculatedBpm ? `Tap tempo, ${calculatedBpm} BPM` : 'Tap tempo'}
        className={`w-full h-20 rounded-xs bg-white/10 border-b-2 font-bold text-lg transition-[color,box-shadow,border-color] ${lift} ${
          isActive
            ? 'text-[rgb(var(--et-accent))] border-b-[rgb(var(--et-accent))]'
            : 'et-ink-2 border-b-transparent hover:et-ink'
        }`}
      >
        {calculatedBpm ? (
          <span className="text-2xl">{calculatedBpm} <span className="text-sm">BPM</span></span>
        ) : (
          <span>TAP</span>
        )}
      </button>

      {/* Tap count indicator */}
      <div className="flex justify-between items-center mt-2">
        <span className="text-[12px] font-semibold et-ink-3">
          {taps.length > 0 ? `${taps.length} taps` : 'Tap to start'}
        </span>
        {taps.length >= 2 && (
          <div className="flex gap-1" aria-hidden="true">
            {Array.from({ length: Math.min(taps.length, 8) }).map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${
                  i < taps.length ? 'bg-[rgb(var(--et-accent))]' : 'bg-white/10'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Apply button */}
      {calculatedBpm && (
        <button
          type="button"
          onClick={handleApply}
          className={`w-full mt-3 py-2 rounded-xs bg-white/10 border-b border-b-[rgb(var(--et-accent))] text-[rgb(var(--et-accent))] text-xs font-semibold transition-shadow ${lift}`}
        >
          Set BPM to {calculatedBpm} (current: {currentBpm})
        </button>
      )}

      <p className="text-[12px] font-semibold et-ink-3 mt-2 text-center">
        Tap along with your beat. Best accuracy with 4-8 taps.
      </p>
    </div>
  );
};
