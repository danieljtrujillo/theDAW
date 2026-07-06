/**
 * SemanticWave — the DJ tab's frequency-coloured waveform (DJSemanticWaveform)
 * made reusable across MAKE / EDIT / MIX. It layers the interactive overlays
 * that live inside DJView's DeckWaveform (playhead, click/drag-to-seek, an
 * optional mask region) but WITHOUT any coupling to the DJ engine, so callers
 * drive it with plain props:
 *   - progress: 0..1 playhead position (null = no playhead)
 *   - onSeek(frac): pointer scrub, frac is 0..1 of the full track
 *   - region: a draggable normalised mask band (replaces the WaveSurfer plugin)
 */
import React, { useRef } from 'react';
import { DJSemanticWaveform } from './DJSemanticWaveform';

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export interface SemanticWaveRegion {
  /** Band edges as fractions (0..1) of the full track. */
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}

export interface SemanticWaveProps {
  audioUrl: string;
  height?: number;
  /** Visible window into the track (0..1); used for EDIT clip trims. */
  viewportStart?: number;
  viewportEnd?: number;
  /** Playhead position as a fraction (0..1) of the full track; null hides it. */
  progress?: number | null;
  /** Pointer scrub. Receives a fraction (0..1) of the full track. */
  onSeek?: (frac: number) => void;
  /** Optional draggable mask band (fractions of the full track). */
  region?: SemanticWaveRegion;
  /** Reports decoded length in seconds (for callers that store mask in seconds). */
  onDuration?: (seconds: number) => void;
  transparentBg?: boolean;
  className?: string;
  ariaLabel?: string;
}

export const SemanticWave: React.FC<SemanticWaveProps> = ({
  audioUrl,
  height = 64,
  viewportStart = 0,
  viewportEnd = 1,
  progress = null,
  onSeek,
  region,
  onDuration,
  transparentBg = false,
  className,
  ariaLabel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1e-6, viewportEnd - viewportStart);

  // Map a full-track fraction to a horizontal percentage within the viewport.
  const toPct = (frac: number) => clamp01((frac - viewportStart) / span) * 100;
  // Map a pointer clientX to a full-track fraction.
  const fracFromClientX = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const local = clamp01((clientX - rect.left) / Math.max(1, rect.width));
    return clamp01(viewportStart + local * span);
  };

  // --- scrub-to-seek ------------------------------------------------------
  const seeking = useRef(false);
  const onSeekDown = (e: React.PointerEvent) => {
    if (!onSeek) return;
    seeking.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onSeek(fracFromClientX(e.clientX));
  };
  const onSeekMove = (e: React.PointerEvent) => {
    if (seeking.current && onSeek) onSeek(fracFromClientX(e.clientX));
  };
  const onSeekUp = (e: React.PointerEvent) => {
    seeking.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // --- region drag --------------------------------------------------------
  const dragEdge = useRef<'start' | 'end' | null>(null);
  const onEdgeDown = (edge: 'start' | 'end') => (e: React.PointerEvent) => {
    if (!region) return;
    e.stopPropagation();
    dragEdge.current = edge;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onRegionMove = (e: React.PointerEvent) => {
    if (!region || !dragEdge.current) return;
    const f = fracFromClientX(e.clientX);
    if (dragEdge.current === 'start') region.onChange(Math.min(f, region.end), region.end);
    else region.onChange(region.start, Math.max(f, region.start));
  };
  const onRegionUp = (e: React.PointerEvent) => {
    dragEdge.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const bg = transparentBg ? 'transparent' : '#06070d';

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full min-w-0 overflow-hidden rounded ${className ?? ''}`}
      style={{ height, background: bg }}
    >
      <DJSemanticWaveform
        audioUrl={audioUrl}
        height={height}
        viewportStart={viewportStart}
        viewportEnd={viewportEnd}
        onDuration={onDuration}
      />

      {/* scrub layer */}
      {onSeek && (
        <div
          role="slider"
          aria-label={ariaLabel ?? 'Seek waveform'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clamp01(progress ?? 0) * 100)}
          tabIndex={0}
          className="absolute inset-0 z-10 cursor-ew-resize touch-none"
          onPointerDown={onSeekDown}
          onPointerMove={onSeekMove}
          onPointerUp={onSeekUp}
          onPointerCancel={onSeekUp}
        />
      )}

      {/* mask region */}
      {region && (
        <div
          className="absolute inset-0 z-20 touch-none"
          onPointerMove={onRegionMove}
          onPointerUp={onRegionUp}
          onPointerCancel={onRegionUp}
        >
          <div
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: `${toPct(region.start)}%`,
              width: `${Math.max(0, toPct(region.end) - toPct(region.start))}%`,
              background: 'rgba(168,85,247,0.22)',
              borderLeft: '2px solid rgba(168,85,247,0.85)',
              borderRight: '2px solid rgba(168,85,247,0.85)',
            }}
          />
          <div
            role="slider"
            aria-label="Mask region start"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clamp01(region.start) * 100)}
            tabIndex={0}
            className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize"
            style={{ left: `${toPct(region.start)}%` }}
            onPointerDown={onEdgeDown('start')}
          />
          <div
            role="slider"
            aria-label="Mask region end"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clamp01(region.end) * 100)}
            tabIndex={0}
            className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize"
            style={{ left: `${toPct(region.end)}%` }}
            onPointerDown={onEdgeDown('end')}
          />
        </div>
      )}

      {/* playhead */}
      {progress != null && progress >= viewportStart && progress <= viewportEnd && (
        <div
          className="absolute top-0 bottom-0 z-30 pointer-events-none"
          style={{
            left: `${toPct(progress)}%`,
            width: '2px',
            background: '#ffffff',
            boxShadow: '0 0 4px rgba(255,255,255,0.8)',
          }}
        />
      )}
    </div>
  );
};
