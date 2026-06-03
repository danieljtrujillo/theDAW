import React, { useEffect, useRef } from 'react';
import { WaveformPreview } from './WaveformPreview';
import { usePlayerStore } from '../../state/playerStore';

/* FooterScrubWave — an output waveform that scrubs the global FOOTER player.
 *
 * Click/drag seeks playerStore (seekByFraction); a playhead is synced
 * imperatively to playback (subscribe, no per-frame re-render). Used by the
 * MAKE Compare output and the MIX Process output so both route through the one
 * master engine + visualizer graph instead of a disconnected wavesurfer copy.
 * The host loads the result into playerStore (generateStore / studioStore), so
 * this waveform's playhead and seek line up with whatever the footer holds. */
export function FooterScrubWave({ src, height }: { src: string; height: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const seekByFraction = usePlayerStore((s) => s.seekByFraction);
  const scrubbing = useRef(false);

  useEffect(() => {
    const update = (s: { currentTime: number; duration: number }) => {
      if (playheadRef.current) playheadRef.current.style.left = s.duration > 0 ? `${(s.currentTime / s.duration) * 100}%` : '0%';
    };
    update(usePlayerStore.getState());
    return usePlayerStore.subscribe(update);
  }, []);

  const seekTo = (clientX: number) => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    seekByFraction((clientX - r.left) / r.width);
  };
  const onDown = (e: React.PointerEvent) => { scrubbing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekTo(e.clientX); };
  const onMove = (e: React.PointerEvent) => { if (scrubbing.current) seekTo(e.clientX); };
  const onUp = (e: React.PointerEvent) => { scrubbing.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };

  return (
    <div ref={wrapRef} className="relative h-full">
      <WaveformPreview audioUrl={src} height={height} interact={false} />
      <div className="absolute inset-0 z-10 cursor-ew-resize touch-none" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} title="Drag to scrub · click to seek (footer)" />
      <div ref={playheadRef} className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: '0%', width: '2px', background: '#ffffff', boxShadow: '0 0 4px rgba(255,255,255,0.8)' }} />
    </div>
  );
}
