import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, Download, Music, Share2, Heart, Repeat, VolumeX, Maximize2, MoreHorizontal } from 'lucide-react';
import { motion } from 'motion/react';
import { useGenerateStore } from '../../state/generateStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { usePlayerStore } from '../../state/playerStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useActiveViewStore } from '../../state/activeViewStore';
import { callEditorPlay, isEditorPlaybackRegistered } from '../../state/editorPlaybackBridge';

const formatDuration = (sec: number | null | undefined): string => {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--';
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const PlayerFooter: React.FC = () => {
  const [isLiked, setIsLiked] = useState(false);
  const progressRef = useRef<HTMLDivElement | null>(null);

  // Volume / mute live in playbackStore; they drive the engine's master gain.
  const volume = usePlaybackStore((s) => s.volume);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const isMuted = usePlaybackStore((s) => s.muted);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);

  // Engine state
  const engineLabel = usePlayerStore((s) => s.currentLabel);
  const engineDuration = usePlayerStore((s) => s.duration);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLooping = usePlayerStore((s) => s.isLooping);
  const hasTrack = usePlayerStore((s) => s.hasTrack);
  const toggle = usePlayerStore((s) => s.toggle);
  const seekByFraction = usePlayerStore((s) => s.seekByFraction);
  const toggleLoop = usePlayerStore((s) => s.toggleLoop);
  const setMasterGain = usePlayerStore((s) => s.setMasterGain);
  const load = usePlayerStore((s) => s.load);
  const currentEntryId = usePlayerStore((s) => s.currentEntryId);

  // Last-generation metadata (used when nothing's been explicitly loaded yet).
  const lastFilename = useGenerateStore((s) => s.lastFilename);
  const lastDurationSec = useGenerateStore((s) => s.lastDurationSec);
  const lastModelName = useGenerateStore((s) => s.lastModelName);

  // Editor mode — when the EDIT tab is active and editor bridge is registered,
  // the first play click triggers an offline render into playerStore.
  // After that, all transport (seek, skip, loop, volume) works natively.
  const activeView = useActiveViewStore((s) => s.activeView);
  const inEditorMode = activeView === 'edit' && isEditorPlaybackRegistered();

  // Volume → master gain (continuous).
  useEffect(() => {
    setMasterGain(isMuted ? 0 : volume / 100);
  }, [volume, isMuted, setMasterGain]);

  // Auto-load: when a new generation lands and nothing is currently loaded, load it.
  useEffect(() => {
    if (hasTrack) return;
    const entries = useLibraryStore.getState().entries;
    if (entries.length === 0) return;
    const newest = entries.reduce((acc, e) => (e.timestamp.localeCompare(acc.timestamp) > 0 ? e : acc), entries[0]);
    if (newest) {
      void load(newest.audioBlob, { label: newest.title, entryId: newest.id });
    }
  }, [hasTrack, lastFilename, load]);

  const displayLabel = engineLabel ?? lastFilename ?? null;
  const displayDuration = engineDuration > 0 ? engineDuration : (lastDurationSec ?? 0);
  const displayCurrentTime = currentTime;
  const displayIsPlaying = isPlaying;
  const progressPct = displayDuration > 0 ? Math.min(100, (displayCurrentTime / displayDuration) * 100) : 0;

  const handleToggle = () => {
    // In editor mode, if editor audio isn't loaded yet, trigger the offline render+play.
    // Once loaded (entryId === 'editor-timeline'), toggle works natively.
    if (inEditorMode && currentEntryId !== 'editor-timeline') {
      callEditorPlay();
    } else {
      toggle();
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = progressRef.current;
    if (!el || displayDuration <= 0) return;
    const rect = el.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seekByFraction(frac);
  };

  const handleDownload = () => {
    const entries = useLibraryStore.getState().entries;
    const target = entries.find((e) => e.id === currentEntryId) ?? entries[0];
    if (!target) return;
    const url = useLibraryStore.getState().getAudioUrl(target);
    const a = document.createElement('a');
    a.href = url;
    a.download = target.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <footer className="fixed bottom-0 left-0 right-0 h-20 bg-[#0a080f]/95 backdrop-blur-xl border-t border-white/5 z-50 px-6 flex items-center justify-between gap-8 group">
      {/* 1. Track Info & Actions */}
      <div className="flex items-center gap-4 w-75 shrink-0">
        <div className="w-11 h-11 rounded-lg bg-linear-to-br from-purple-500/20 to-blue-500/20 border border-white/5 flex items-center justify-center relative overflow-hidden group/thumb">
          <Music className="w-5 h-5 text-purple-400 group-hover/thumb:scale-110 transition-transform" />
          {isPlaying && (
            <motion.div
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              className="absolute inset-0 bg-purple-500/10"
            />
          )}
        </div>
        <div className="flex flex-col min-w-0">
          <h4 className="text-[13px] font-bold text-zinc-100 truncate tracking-tight">
            {displayLabel ?? 'No output loaded'}
          </h4>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-purple-400 font-mono uppercase tracking-widest border border-purple-500/20 px-1 rounded bg-purple-500/5">
              {lastModelName ? lastModelName.toUpperCase() : (displayLabel ? 'LIBRARY' : 'IDLE')}
            </span>
            <span className="text-[10px] text-zinc-500 font-mono">
              {displayDuration > 0 ? `${formatDuration(displayDuration)} // 48kHz` : '--:-- // 48kHz'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => setIsLiked(!isLiked)} className={`p-1.5 transition-colors ${isLiked ? 'text-pink-500' : 'text-zinc-600 hover:text-white'}`}>
             <Heart className={`w-3.5 h-3.5 ${isLiked ? 'fill-current' : ''}`} />
          </button>
          <button className="p-1.5 text-zinc-600 hover:text-white transition-colors">
             <Share2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Main Transport Control */}
      <div className="flex-1 flex flex-col items-center gap-1.5 max-w-2xl min-w-0">
        <div className="flex items-center gap-8">
          <button
            onClick={toggleLoop}
            className={`p-1 transition-colors ${isLooping ? 'text-purple-400' : 'text-zinc-600 hover:text-white'}`}
            title={isLooping ? 'Looping on' : 'Looping off'}
          >
            <Repeat className="w-4 h-4" />
          </button>
          <button
            onClick={() => seekByFraction(0)}
            className="text-zinc-500 hover:text-white transition-colors disabled:opacity-30"
            disabled={!inEditorMode && !hasTrack}
            title="Jump to start"
          >
            <SkipBack className="w-5 h-5 fill-current" />
          </button>
          <button
            onClick={handleToggle}
            disabled={!inEditorMode && !hasTrack}
            className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-all shadow-[0_0_15px_rgba(255,255,255,0.2)] disabled:opacity-40 disabled:pointer-events-none"
            title={displayIsPlaying ? 'Pause' : 'Play'}
          >
            {displayIsPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
          </button>
          <button
            onClick={() => seekByFraction(1)}
            className="text-zinc-500 hover:text-white transition-colors disabled:opacity-30"
            disabled={!hasTrack}
            title="Jump to end"
          >
            <SkipForward className="w-5 h-5 fill-current" />
          </button>
          <button
            onClick={() => {
              if (document.fullscreenElement) {
                void document.exitFullscreen();
              } else {
                void document.documentElement.requestFullscreen();
              }
            }}
            className="p-1 text-zinc-600 hover:text-white transition-colors"
            title="Toggle fullscreen"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>

        <div className="w-full flex items-center gap-3">
          <span className="text-[10px] font-mono text-zinc-500 w-8 text-right">{formatDuration(displayCurrentTime)}</span>
          <div
            ref={progressRef}
            onClick={handleProgressClick}
            className="flex-1 h-0.75 bg-white/5 rounded-full relative group/bar cursor-pointer"
          >
            <div className="absolute inset-0 bg-white/5" />
            <div
              className="absolute inset-y-0 left-0 bg-linear-to-r from-purple-600 to-purple-400 rounded-full"
              style={{ width: `${progressPct}%` }}
            >
              <div className="hidden group-hover/bar:block absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-[0_0_8px_rgba(139,92,246,0.6)]" />
            </div>
          </div>
          <span className="text-[10px] font-mono text-zinc-500 w-8">{formatDuration(displayDuration)}</span>
        </div>
      </div>

      {/* 3. Utilities */}
      <div className="flex items-center justify-end gap-6 w-[320px] shrink-0">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-3">
            <button onClick={toggleMute} className="text-zinc-500 hover:text-white transition-colors" title={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted || volume === 0 ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <div className="w-20 h-1 bg-white/10 rounded-full relative">
              <input
                type="range"
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="absolute inset-0 opacity-0 cursor-pointer z-10"
                title="Volume"
              />
              <div
                className={`h-full rounded-full transition-colors ${isMuted ? 'bg-zinc-700' : 'bg-purple-500'}`}
                style={{ width: `${isMuted ? 0 : volume}%` }}
              />
            </div>
          </div>

          <div className="h-6 w-px bg-white/5" />

          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              disabled={!hasTrack}
              className="p-2 border border-white/5 rounded-lg hover:border-purple-500/50 hover:bg-purple-500/5 transition-all text-zinc-500 hover:text-purple-400 disabled:opacity-30 disabled:pointer-events-none"
              title="Download current track"
            >
               <Download className="w-4 h-4" />
            </button>
            <button className="p-2 border border-white/5 rounded-lg hover:border-white/20 transition-all text-zinc-500 hover:text-white">
               <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

    </footer>
  );
};
