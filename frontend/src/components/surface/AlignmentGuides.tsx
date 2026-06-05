/**
 * Design-Mode alignment overlay: a bright vertical + horizontal CENTER line
 * spanning the whole surface, plus fainter increment lines at the eighths, so
 * the user can line panels and controls up to centre and to regular fractions
 * while dragging. Purely visual — pointer-events-none, so it never intercepts
 * drags — and sits below the toolbar.
 */
import React from 'react';

// Eighths, excluding the centre (drawn brighter) and the edges.
const FRACTIONS = [12.5, 25, 37.5, 62.5, 75, 87.5];

export const AlignmentGuides: React.FC = () => (
  <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
    {FRACTIONS.map((p) => (
      <React.Fragment key={p}>
        <div className="absolute top-0 bottom-0 w-px bg-cyan-300/10" style={{ left: `${p}%` }} />
        <div className="absolute left-0 right-0 h-px bg-cyan-300/10" style={{ top: `${p}%` }} />
      </React.Fragment>
    ))}
    {/* centre crosshair */}
    <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px bg-cyan-300/40" />
    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-cyan-300/40" />
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full border border-cyan-300/60" />
  </div>
);
