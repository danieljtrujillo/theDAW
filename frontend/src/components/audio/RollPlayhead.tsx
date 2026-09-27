/**
 * RollPlayhead — the piano roll's playhead, in its own module so a node test
 * renders it (PianoRoll.tsx's module graph reads `import.meta.env`).
 */
import React from 'react';
import { usePianoRollStore } from '../../state/pianoRollStore';

/** The playhead: a 1px line in the theme's primary ink, which holds contrast on
 *  the grid and across the accent-filled notes. No glow. Only this re-renders
 *  as the roll plays. It sits on the step line where the step it marks starts,
 *  so the line meets a note as the note sounds, and it stays in view, fainter,
 *  while the roll is stopped: that is where PLAY starts. */
export const RollPlayhead: React.FC<{ stepPx: number; totalSteps: number }> = ({ stepPx, totalSteps }) => {
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => s.currentStep);
  return (
    <div
      aria-hidden="true"
      className={`absolute top-0 bottom-0 w-px bg-[rgb(var(--et-ink))] z-30 pointer-events-none ${isPlaying ? '' : 'opacity-40'}`}
      style={{ left: Math.min(Math.max(0, currentStep), totalSteps) * stepPx }}
    />
  );
};
