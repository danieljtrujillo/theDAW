import React, { useRef, useState } from 'react';
import { FolderPlus, Trash2, Music, FileAudio, UploadCloud, Send, Library } from 'lucide-react';
import { useMediaBucketStore, type BucketItem } from '../../state/mediaBucketStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { logError, logInfo } from '../../state/logStore';

const fmtSize = (b: number): string => {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};

const isAudio = (mime: string, name: string): boolean =>
  mime.startsWith('audio/') || /\.(wav|mp3|flac|ogg|aac|m4a|opus)$/i.test(name);

export const MediaBucketView: React.FC = () => {
  const items = useMediaBucketStore((s) => s.items);
  const addMany = useMediaBucketStore((s) => s.addMany);
  const remove = useMediaBucketStore((s) => s.remove);
  const clear = useMediaBucketStore((s) => s.clear);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleSendToEditor = async (item: BucketItem) => {
    if (!isAudio(item.mimeType, item.name)) {
      logError('bucket', `${item.name} is not an audio file`);
      return;
    }
    try {
      const editor = useEditorStore.getState();
      const { peaks, duration } = await computePeaks(item.blob, 240);
      const trackId = editor.addTrack({ name: item.name });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const clipId = editor.addClipToTrack({
        trackId,
        label: item.name,
        audioBlob: item.blob,
        mimeType: item.mimeType,
        sourceDuration: duration,
        offsetIntoSource: 0,
        durationSec: duration,
        startSec: 0,
        color: trackColor,
      });
      editor.cachePeaks(clipId, peaks);
    } catch (e) {
      logError('bucket', `Send to editor failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleSendToLibrary = async (item: BucketItem) => {
    if (!isAudio(item.mimeType, item.name)) {
      logError('bucket', `${item.name} is not an audio file`);
      return;
    }
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const ab = await item.blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(ab.slice(0));
      await ctx.close();
      await useLibraryStore.getState().addEntry({
        id: `bucket-${item.id}`,
        title: item.name,
        prompt: 'Imported from media bucket',
        negativePrompt: '',
        model: 'imported',
        duration: decoded.duration,
        steps: 0,
        cfg: 0,
        seed: -1,
        audioBlob: item.blob,
        mimeType: item.mimeType,
        timestamp: new Date().toISOString(),
        favorite: false,
        rating: null,
        tags: ['imported'],
        notes: '',
        source: 'import',
      });
      logInfo('bucket', `Imported ${item.name} into library`);
    } catch (e) {
      logError('bucket', `Send to library failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0a080f]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-white/5 bg-black/40 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-zinc-500">{items.length} file{items.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="relative">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*,.mid,.midi,image/*"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) addMany(e.target.files);
                e.target.value = '';
              }}
              title="Add files to the bucket"
            />
            <span className="btn-ghost text-[9px] py-1 flex items-center gap-1.5 pointer-events-none">
              <FolderPlus className="w-3 h-3 text-purple-300" /> ADD FILES
            </span>
          </label>
          {items.length > 0 && (
            <button onClick={clear} className="btn-ghost text-[9px] py-1 flex items-center gap-1.5" title="Empty the bucket">
              <Trash2 className="w-3 h-3" /> CLEAR
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) addMany(e.dataTransfer.files);
        }}
        className={`flex-1 min-h-0 overflow-y-auto p-2 transition-colors ${dragOver ? 'bg-purple-500/10 ring-2 ring-inset ring-purple-500/40' : ''}`}
      >
        {items.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-zinc-700 italic">
            <UploadCloud className="w-8 h-8" />
            <p className="text-[10px] font-mono uppercase tracking-widest">Drop files anywhere in this panel or click ADD FILES</p>
            <p className="text-[9px] text-zinc-800">Audio / MIDI / image — anything you want quick access to.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map((item) => (
              <div
                key={item.id}
                draggable={isAudio(item.mimeType, item.name)}
                onDragStart={(e) => {
                  // Browser-native: drag the file out to OS / other apps.
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('text/plain', item.name);
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded border border-white/5 bg-black/20 hover:bg-white/3 group"
              >
                <div className="shrink-0">
                  {isAudio(item.mimeType, item.name) ? (
                    <Music className="w-3 h-3 text-purple-300" />
                  ) : (
                    <FileAudio className="w-3 h-3 text-zinc-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-zinc-200 truncate">{item.name}</p>
                  <p className="text-[8px] font-mono text-zinc-600">
                    {fmtSize(item.size)} · {item.mimeType || 'unknown'}
                  </p>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => void handleSendToEditor(item)}
                    disabled={!isAudio(item.mimeType, item.name)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-purple-300 disabled:opacity-30"
                    title="Send to a new editor track"
                  >
                    <Send className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => void handleSendToLibrary(item)}
                    disabled={!isAudio(item.mimeType, item.name)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-purple-300 disabled:opacity-30"
                    title="Save to library"
                  >
                    <Library className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => remove(item.id)}
                    className="p-1 rounded hover:bg-red-500/20 text-zinc-500 hover:text-red-400"
                    title="Remove from bucket"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
