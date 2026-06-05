import { useEffect, useRef } from 'react';
import { useWavesurfer } from '@wavesurfer/react';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import type WaveSurfer from 'wavesurfer.js';

export interface WaveformPreviewProps {
  audioUrl?: string;
  height?: number;
  enableRegions?: boolean;
  regionStart?: number;
  regionEnd?: number;
  onRegionChange?: (start: number, end: number) => void;
  onReady?: (ws: WaveSurfer) => void;
  /** Let wavesurfer handle its own click-to-seek cursor. Off for the DJ decks,
   *  where an overlay drives our own engine instead. Default true. */
  interact?: boolean;
  /** Wave/progress colours — override for A/B overlay comparison (e.g. a cyan
   *  input behind a purple output). Defaults keep the standard purple. */
  waveColor?: string;
  progressColor?: string;
  /** Transparent panel background (for overlay layering). Default opaque. */
  transparentBg?: boolean;
}

export function WaveformPreview({
  audioUrl,
  height = 64,
  enableRegions = false,
  regionStart,
  regionEnd,
  onRegionChange,
  onReady,
  interact = true,
  waveColor = '#7c3aed',
  progressColor = '#a855f7',
  transparentBg = false,
}: WaveformPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);

  const { wavesurfer, isReady } = useWavesurfer({
    container: containerRef,
    url: audioUrl,
    height,
    waveColor,
    progressColor,
    cursorColor: '#e2e0ea',
    cursorWidth: 1,
    barWidth: 2,
    barGap: 1,
    barRadius: 1,
    normalize: true,
    fillParent: true,
    interact,
    hideScrollbar: true,
  });

  const prevWsRef = useRef<WaveSurfer | null>(null);
  if (wavesurfer && isReady && wavesurfer !== prevWsRef.current) {
    prevWsRef.current = wavesurfer;
    onReady?.(wavesurfer);
  }

  useEffect(() => {
    if (!wavesurfer || !isReady || !enableRegions) return;

    const regions = RegionsPlugin.create();
    wavesurfer.registerPlugin(regions);
    regionsRef.current = regions;

    const disableDrag = regions.enableDragSelection({
      color: 'rgba(168, 85, 247, 0.3)',
    });

    if (regionStart != null && regionEnd != null && regionEnd > regionStart) {
      regions.addRegion({
        start: regionStart,
        end: regionEnd,
        color: 'rgba(168, 85, 247, 0.3)',
        drag: true,
        resize: true,
      });
    }

    const onCreated = (region: { start: number; end: number; remove?: () => void }) => {
      const all = regions.getRegions();
      all.forEach((r) => {
        if (r !== region) r.remove();
      });
      onRegionChange?.(region.start, region.end);
    };

    const onUpdated = (region: { start: number; end: number }) => {
      onRegionChange?.(region.start, region.end);
    };

    regions.on('region-created', onCreated);
    regions.on('region-updated', onUpdated);

    return () => {
      disableDrag();
      regions.destroy();
      regionsRef.current = null;
    };
  }, [wavesurfer, isReady, enableRegions, regionStart, regionEnd, onRegionChange]);

  return (
    <div
      style={{
        width: '100%',
        height,
        background: transparentBg ? 'transparent' : '#0e0c18',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

