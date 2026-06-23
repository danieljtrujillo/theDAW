import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Layers, X, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { useGenerateParamsStore, type ChimeraClip } from '../../state/generateParamsStore';
import { keyLabel, toCamelot } from '../../lib/camelot';
import { addBlobsToChimera } from '../../lib/chimeraClient';
import { SlideTrack } from '../audio/SlideTrack';
import { hasAudioDragData, readAudioDragData } from '../../lib/audioDnD';
import { useExternalDragStore } from '../../state/externalDragStore';
import { logError } from '../../state/logStore';
import { ChimeraControls } from './ChimeraControls';
import { laneColor, rgbCss } from './dna/dnaPalette';

const isAudio = (mime: string, name: string): boolean =>
  mime.startsWith('audio/') || /\.(wav|mp3|flac|ogg|aac|m4a|opus)$/i.test(name);

const fmtBpm = (bpm: number | null | undefined): string => {
  if (bpm == null) return '—';
  return bpm.toFixed(1);
};

const fmtRatio = (r: number | undefined): string => {
  if (r == null) return '—';
  return `×${r.toFixed(2)}`;
};


export const ChimeraStack: React.FC = () => {
  const clips = useGenerateParamsStore((s) => s.chimera.clips);
  const lastMeta = useGenerateParamsStore((s) => s.chimera.lastMeta);
  const removeChimeraClip = useGenerateParamsStore((s) => s.removeChimeraClip);
  const updateChimeraClip = useGenerateParamsStore((s) => s.updateChimeraClip);
  const moveChimeraClip = useGenerateParamsStore((s) => s.moveChimeraClip);
  const reorderChimeraClips = useGenerateParamsStore((s) => s.reorderChimeraClips);
  const [dragSrc, setDragSrc] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const externalActive = useExternalDragStore((s) => s.active);
  const externalItems = useExternalDragStore((s) => s.items);
  const endExternal = useExternalDragStore((s) => s.end);

  useEffect(() => {
    if (!externalActive) return;
    const onDocPointerUp = (e: PointerEvent) => {
      const zone = dropZoneRef.current;
      if (zone && externalItems.length > 0) {
        const r = zone.getBoundingClientRect();
        const inside =
          e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom;
        if (inside) {
          addBlobsToChimera(externalItems);
        }
      }
      endExternal();
    };
    document.addEventListener('pointerup', onDocPointerUp);
    return () => document.removeEventListener('pointerup', onDocPointerUp);
  }, [externalActive, externalItems, endExternal]);

  const ingestFiles = useCallback((files: FileList | File[]) => {
    const list: File[] = [];
    for (const f of Array.from(files)) {
      if (isAudio(f.type, f.name)) list.push(f);
      else logError('chimera', `Skipped non-audio file: ${f.name}`);
    }
    if (list.length === 0) return;
    addBlobsToChimera(
      list.map((f) => ({ blob: f, mimeType: f.type || 'audio/wav', label: f.name })),
    );
  }, []);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) ingestFiles(e.target.files);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (hasAudioDragData(e)) {
      void (async () => {
        const items = await readAudioDragData(e);
        if (items.length === 0) return;
        addBlobsToChimera(items);
      })();
      return;
    }
    if (e.dataTransfer?.files?.length) {
      ingestFiles(e.dataTransfer.files);
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
    if (hasAudioDragData(e) && e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDragLeave = () => setDragOver(false);

  const metaByLabel = new Map<string, NonNullable<typeof lastMeta>['per_clip'][number]>();
  if (lastMeta) {
    lastMeta.per_clip.forEach((pc) => metaByLabel.set(pc.label, pc));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-purple-300/80 font-mono tracking-widest uppercase flex items-center gap-1">
          <Layers className="w-2.5 h-2.5" />
          Chimera stack ({clips.length})
        </span>
        {clips.length >= 2 && (
          <span className="text-[8px] text-purple-400/70 font-mono uppercase tracking-widest">
            mashup at CREATE
          </span>
        )}
      </div>

      {clips.length > 0 && (
        <div className="flex flex-col gap-1">
          {clips.map((clip, idx) => (
            <div
              key={clip.id}
              draggable
              onDragStart={(e) => {
                setDragSrc(clip.id);
                e.dataTransfer.effectAllowed = 'move';
                // Use a custom MIME so the cross-component external-drag
                // bus doesn't pick this up as an audio drop.
                e.dataTransfer.setData('application/x-thedaw-chimera-row', clip.id);
              }}
              onDragOver={(e) => {
                if (!dragSrc || dragSrc === clip.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOverId(clip.id);
              }}
              onDragLeave={() => {
                if (dragOverId === clip.id) setDragOverId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragSrc || dragSrc === clip.id) return;
                const order = clips.map((c) => c.id);
                const fromIdx = order.indexOf(dragSrc);
                const toIdx = order.indexOf(clip.id);
                if (fromIdx === -1 || toIdx === -1) return;
                order.splice(fromIdx, 1);
                order.splice(toIdx, 0, dragSrc);
                reorderChimeraClips(order);
                setDragSrc(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDragSrc(null);
                setDragOverId(null);
              }}
              className={dragOverId === clip.id ? 'ring-1 ring-purple-400/60 rounded' : ''}
            >
              <ChimeraRow
                clip={clip}
                clipsAll={clips}
                detectedBpm={metaByLabel.get(clip.label)?.detected_bpm ?? clip.detectedBpm ?? null}
                stretchRatio={metaByLabel.get(clip.label)?.stretch_ratio ?? clip.stretchRatio}
                index={idx}
                total={clips.length}
                onRemove={() => removeChimeraClip(clip.id)}
                onNoiseChange={(v) => updateChimeraClip(clip.id, { noise: v })}
                onMoveUp={() => moveChimeraClip(clip.id, 'up')}
                onMoveDown={() => moveChimeraClip(clip.id, 'down')}
              />
            </div>
          ))}
        </div>
      )}

      <ChimeraControls />

      <div
        ref={dropZoneRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative border border-dashed rounded p-2 cursor-pointer transition-colors text-center ${
          dragOver || externalActive
            ? 'border-purple-400 bg-purple-500/10'
            : 'border-purple-500/30 hover:border-purple-400/60 hover:bg-purple-500/5'
        }`}
      >
        <input
          ref={fileInputRef}
          name="chimera-audio-file"
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={onPickFiles}
        />
        <span className="text-[9px] font-mono text-purple-300/80 tracking-widest uppercase">
          {clips.length === 0
            ? 'Drop or click to start a Chimera (stack 2+ tracks)'
            : 'Drop more tracks here for a Chimera'}
        </span>
      </div>

      {lastMeta && (
        <div className="text-[9px] font-mono text-zinc-500 mt-0.5">
          Last mashup: {lastMeta.duration_sec.toFixed(2)}s @ {lastMeta.target_bpm_used.toFixed(1)} BPM
          {' '}({lastMeta.target_bpm_source}), {lastMeta.align_mode_used}-aligned
        </div>
      )}
    </div>
  );
};

interface ChimeraRowProps {
  clip: ChimeraClip;
  clipsAll: ChimeraClip[];
  detectedBpm: number | null;
  stretchRatio: number | undefined;
  index: number;
  total: number;
  onRemove: () => void;
  onNoiseChange: (v: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

const ChimeraRow: React.FC<ChimeraRowProps> = ({
  clip,
  clipsAll,
  detectedBpm,
  stretchRatio,
  index,
  total,
  onRemove,
  onNoiseChange,
  onMoveUp,
  onMoveDown,
}) => {
  const updateChimeraClip = useGenerateParamsStore((s) => s.updateChimeraClip);
  const setChimeraField = useGenerateParamsStore((s) => s.setChimeraField);

  const baseDisabled = detectedBpm == null;

  const toggleBase = () => {
    if (baseDisabled) return;
    if (clip.isBase) {
      updateChimeraClip(clip.id, { isBase: false });
      setChimeraField('targetBpm', 'auto');
      return;
    }
    clipsAll.forEach((c) => {
      if (c.id !== clip.id && c.isBase) {
        updateChimeraClip(c.id, { isBase: false });
      }
    });
    updateChimeraClip(clip.id, { isBase: true });
    if (detectedBpm != null) {
      setChimeraField('targetBpm', detectedBpm);
    }
  };

  const badge = 'bg-black/40 backdrop-blur-sm rounded px-1 py-0.5 pointer-events-auto';

  return (
    <div
      data-crispr-lane
      data-clip-id={clip.id}
      data-lane-index={index}
      className={`relative overflow-hidden rounded h-16 text-[9px] font-mono border ${
        clip.isBase ? 'bg-purple-500/5 border-purple-400/40' : 'border-white/5'
      }`}
    >
      {/* LEFT edge — name + reorder, badges stacked at the strand's start */}
      <div className="absolute inset-y-0 left-0 z-10 flex flex-col items-start justify-between p-1 pointer-events-none">
        <div className={`${badge} flex items-center gap-1`}>
          <GripVertical className="w-3 h-3 text-zinc-500 shrink-0 cursor-grab active:cursor-grabbing" />
          <span
            className="w-2 h-2 rounded-sm shrink-0"
            style={{ backgroundColor: rgbCss(laneColor(index)), boxShadow: `0 0 6px ${rgbCss(laneColor(index))}` }}
            aria-hidden
          />
          <span className="text-zinc-100 truncate max-w-24" title={clip.label}>
            {clip.label}
          </span>
        </div>
        <div className={`${badge} flex items-center gap-1.5`}>
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className="leading-none text-zinc-400 hover:text-purple-300 disabled:opacity-25 disabled:cursor-not-allowed"
            title="Move up"
          >
            <ChevronUp className="w-2.5 h-2.5" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index >= total - 1}
            className="leading-none text-zinc-400 hover:text-purple-300 disabled:opacity-25 disabled:cursor-not-allowed"
            title="Move down"
          >
            <ChevronDown className="w-2.5 h-2.5" />
          </button>
          <span className="text-zinc-300" title="Detected BPM">{fmtBpm(detectedBpm)} BPM</span>
          {clip.keyNote && (() => {
            const cam = toCamelot(clip.keyNote, clip.keyScale ?? null);
            return (
              <span
                className="font-bold"
                style={cam ? { color: `hsl(${cam.hue} 80% 70%)` } : undefined}
                title="Detected key (Camelot)"
              >
                {keyLabel(clip.keyNote, clip.keyScale ?? null)}{cam ? ` · ${cam.code}` : ''}
              </span>
            );
          })()}
          <span className="text-zinc-500" title="Stretch ratio">{fmtRatio(stretchRatio)}</span>
        </div>
      </div>

      {/* RIGHT edge — base/remove + noise, badges stacked at the strand's end */}
      <div className="absolute inset-y-0 right-0 z-10 flex flex-col items-end justify-between p-1 pointer-events-none">
        <div className={`${badge} flex items-center gap-1`}>
          <button
            type="button"
            onClick={toggleBase}
            disabled={baseDisabled}
            title={baseDisabled
              ? 'No beats detected — cannot use as base'
              : clip.isBase
                ? 'Base clip (pins target BPM). Click to unset.'
                : 'Use this clip as the BPM reference'
            }
            className={`px-1.5 py-0.5 rounded border text-[8px] uppercase tracking-widest transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              clip.isBase
                ? 'border-purple-400 bg-purple-500/30 text-purple-100'
                : 'border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5'
            }`}
          >
            Base
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-red-500/10"
            title="Remove from Chimera"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        <div className={`${badge} flex items-center gap-1 w-24`} title="Noise: higher = less influence on output">
          <span className="text-zinc-500">N</span>
          <SlideTrack min={0} max={1} step={0.01} value={clip.noise}
            onChange={(v) => onNoiseChange(v)} className="flex-1" ariaLabel="Noise" />
          <span className="text-zinc-300 w-6 text-right">{clip.noise.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
};

