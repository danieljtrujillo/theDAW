import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Trash2, Music, FileAudio, UploadCloud, Send, Library, Wand2, Link2, Loader2 } from 'lucide-react';
import { useMediaBucketStore, type BucketItem } from '../../state/mediaBucketStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { logError, logInfo } from '../../state/logStore';
import { addBlobsToChimera } from '../../lib/chimeraClient';
import { setAudioDragData } from '../../lib/audioDnD';
import { useAppUiStore } from '../../state/appUiStore';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';

const fmtSize = (b: number): string => {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};

const isAudio = (mime: string, name: string): boolean =>
  mime.startsWith('audio/') || /\.(wav|mp3|flac|ogg|aac|m4a|opus)$/i.test(name);

export const MediaBucketView: React.FC = () => {
  const items = useMediaBucketStore((s) => s.items);
  const hydrated = useMediaBucketStore((s) => s.hydrated);
  const hydrate = useMediaBucketStore((s) => s.hydrate);
  const addMany = useMediaBucketStore((s) => s.addMany);
  const remove = useMediaBucketStore((s) => s.remove);
  const clear = useMediaBucketStore((s) => s.clear);
  const setActiveView = useAppUiStore((s) => s.setActiveView);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const itemMenu = useContextMenu<BucketItem>();

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const selectedAudio = useMemo(
    () => items.filter((it) => selectedIds.includes(it.id) && isAudio(it.mimeType, it.name)),
    [items, selectedIds],
  );

  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && selectionAnchor) {
      const aIdx = items.findIndex((it) => it.id === selectionAnchor);
      const bIdx = items.findIndex((it) => it.id === id);
      if (aIdx >= 0 && bIdx >= 0) {
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        setSelectedIds(items.slice(lo, hi + 1).map((it) => it.id));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      setSelectionAnchor(id);
      return;
    }
    setSelectedIds([id]);
    setSelectionAnchor(id);
  };

  const handleImportUrl = async () => {
    const url = importUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    logInfo('bucket', `Importing from URL: ${url}`);
    try {
      const res = await fetch('/api/ytimport/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = j.detail;
        } catch {
          // non-JSON error body — keep the status string
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const titleHdr = res.headers.get('X-Title');
      const fnameHdr = res.headers.get('X-Filename');
      const title = titleHdr ? decodeURIComponent(titleHdr) : 'import';
      const filename = fnameHdr ? decodeURIComponent(fnameHdr) : `${title}.opus`;
      const file = new File([blob], filename, { type: blob.type || 'audio/ogg' });
      addMany([file]);
      logInfo('bucket', `Imported "${title}" (${fmtSize(blob.size)})`);
      setImportUrl('');
    } catch (e) {
      logError('bucket', `URL import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setImporting(false);
    }
  };

  const sendBlobsToChimeraStack = (entries: BucketItem[]) => {
    const audio = entries.filter((it) => isAudio(it.mimeType, it.name));
    if (audio.length === 0) {
      logError('bucket', 'No audio items in selection to send to INIT');
      return;
    }
    addBlobsToChimera(
      audio.map((it) => ({ blob: it.blob, mimeType: it.mimeType || 'audio/wav', label: it.name })),
    );
    setActiveView('generate');
  };

  const handleSendToInit = (item: BucketItem) => {
    if (selectedIds.includes(item.id) && selectedAudio.length > 1) {
      sendBlobsToChimeraStack(selectedAudio);
    } else {
      sendBlobsToChimeraStack([item]);
    }
  };

  const handleSendSelectedToInit = () => {
    if (selectedAudio.length === 0) return;
    sendBlobsToChimeraStack(selectedAudio);
  };

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
      await useLibraryStore.getState().importEntry({
        blob: item.blob,
        filename: item.name,
        mimeType: item.mimeType,
        metadata: {
          title: item.name,
          prompt: 'Imported from media bucket',
          model: 'imported',
          duration: decoded.duration,
          source: 'import',
          tags: ['imported'],
        },
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
          <span className="text-[9px] font-mono text-zinc-500">
            {items.length} file{items.length === 1 ? '' : 's'}
            {selectedIds.length > 0 && (
              <span className="ml-2 text-purple-300">{selectedIds.length} selected</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {selectedAudio.length >= 2 && (
            <button
              onClick={handleSendSelectedToInit}
              className="btn-ghost text-[9px] py-1 flex items-center gap-1.5 text-purple-300 hover:text-purple-200"
              title={`Send ${selectedAudio.length} selected audio file${selectedAudio.length === 1 ? '' : 's'} to INIT (Chimera stack)`}
            >
              <Wand2 className="w-3 h-3" /> SEND {selectedAudio.length} → INIT
            </button>
          )}
          <label className="relative">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*,.mid,.midi,image/*,video/*"
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

      {/* URL import — paste a YouTube / SoundCloud / Bandcamp link */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5 bg-black/20 shrink-0">
        <Link2 className="w-3 h-3 text-purple-300 shrink-0" />
        <input
          type="text"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleImportUrl();
          }}
          disabled={importing}
          placeholder="Paste a YouTube / SoundCloud / Bandcamp link…"
          spellCheck={false}
          className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-400/50 disabled:opacity-50"
          title="Spotify is DRM-protected and can't be imported"
        />
        <button
          onClick={() => void handleImportUrl()}
          disabled={importing || importUrl.trim().length === 0}
          className="btn-ghost text-[9px] py-1 flex items-center gap-1.5 text-purple-300 hover:text-purple-200 disabled:opacity-40"
          title="Download the best audio (Opus) into the bucket"
        >
          {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
          {importing ? 'IMPORTING…' : 'IMPORT URL'}
        </button>
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
                onClick={(e) => onRowClick(e, item.id)}
                onContextMenu={(e) => {
                  // Right-click selects the row first (unless it's part of a
                  // multi-select) so the menu acts on what the user sees.
                  if (!selectedIds.includes(item.id)) {
                    setSelectedIds([item.id]);
                    setSelectionAnchor(item.id);
                  }
                  itemMenu.open(e, item);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copyMove';
                  e.dataTransfer.setData('text/plain', item.name);
                  const dragItems = selectedIds.includes(item.id) && selectedAudio.length > 1
                    ? selectedAudio
                    : [item];
                  setAudioDragData(e, dragItems.map((it) => ({
                    blob: it.blob,
                    mimeType: it.mimeType || 'audio/wav',
                    label: it.name,
                  })));
                }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded border bg-black/20 hover:bg-white/3 group cursor-pointer ${
                  selectedIds.includes(item.id)
                    ? 'border-purple-400/50 ring-1 ring-purple-500/40 bg-purple-500/8'
                    : 'border-white/5'
                }`}
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
                    onClick={(e) => { e.stopPropagation(); handleSendToInit(item); }}
                    disabled={!isAudio(item.mimeType, item.name)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-purple-300 disabled:opacity-30"
                    title={
                      selectedIds.includes(item.id) && selectedAudio.length > 1
                        ? `Send ${selectedAudio.length} selected to INIT (Chimera)`
                        : 'Send to INIT'
                    }
                  >
                    <Wand2 className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleSendToEditor(item); }}
                    disabled={!isAudio(item.mimeType, item.name)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-purple-300 disabled:opacity-30"
                    title="Send to a new editor track"
                  >
                    <Send className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleSendToLibrary(item); }}
                    disabled={!isAudio(item.mimeType, item.name)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-purple-300 disabled:opacity-30"
                    title="Save to library"
                  >
                    <Library className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); remove(item.id); }}
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

      {/* Right-click menu for a bucket item. */}
      {(() => {
        const item = itemMenu.payload;
        if (!item) return null;
        const audio = isAudio(item.mimeType, item.name);
        const batch = selectedIds.includes(item.id) && selectedAudio.length > 1;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: batch ? `Send ${selectedAudio.length} to INIT (Chimera)` : 'Send to INIT',
            icon: <Wand2 className="w-3 h-3" />,
            hint: 'mix',
            disabled: !audio,
            onSelect: () => handleSendToInit(item),
          },
          {
            type: 'item',
            label: 'Send to editor (new track)',
            icon: <Send className="w-3 h-3" />,
            disabled: !audio,
            onSelect: () => { void handleSendToEditor(item); },
          },
          {
            type: 'item',
            label: 'Save to library',
            icon: <Library className="w-3 h-3" />,
            disabled: !audio,
            onSelect: () => { void handleSendToLibrary(item); },
          },
          { type: 'separator' },
          {
            type: 'item',
            label: batch ? `Remove ${selectedIds.length} from bucket` : 'Remove from bucket',
            icon: <Trash2 className="w-3 h-3" />,
            danger: true,
            onSelect: () => {
              if (batch) selectedIds.forEach((id) => remove(id));
              else remove(item.id);
            },
          },
        ];
        return (
          <ContextMenu
            position={itemMenu.position}
            onClose={itemMenu.close}
            items={items}
            title={item.name}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};

