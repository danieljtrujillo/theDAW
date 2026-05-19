import React from 'react';
import { Database, Tag, Star, Calendar, Clock, Music, Disc, Hash, FileAudio, Layers, Send, Download, Scissors } from 'lucide-react';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { logError } from '../../state/logStore';

const fmtDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0').slice(0, 2)}`;
};

const fmtSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const fmtDate = (iso: string): string => {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
};

const Row: React.FC<{ icon?: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode; mono?: boolean }> = ({
  icon: Icon,
  label,
  value,
  mono = true,
}) => (
  <div className="flex items-center gap-3 py-1 border-b border-white/[0.04]">
    <div className="w-24 flex items-center gap-1.5 flex-shrink-0">
      {Icon && <Icon className="w-2.5 h-2.5 text-zinc-600" />}
      <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">{label}</span>
    </div>
    <span className={`text-[10px] flex-1 min-w-0 truncate ${mono ? 'font-mono text-zinc-200' : 'text-zinc-200'}`}>{value}</span>
  </div>
);

export const DetailsView: React.FC = () => {
  const selectedId = useLibraryStore((s) => s.selectedEntryId);
  const entry: LibraryEntry | undefined = useLibraryStore((s) =>
    s.selectedEntryId ? s.entries.find((e) => e.id === s.selectedEntryId) : undefined,
  );

  const playerLoad = usePlayerStore((s) => s.load);
  const playerPlay = usePlayerStore((s) => s.play);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);

  const handleAuditionInEngine = async () => {
    if (!entry) return;
    await playerLoad(entry.audioBlob, { label: entry.title, entryId: entry.id });
    playerPlay();
  };

  const handleSendToNewEditorTrack = async () => {
    if (!entry) return;
    try {
      const editor = useEditorStore.getState();
      const { peaks, duration } = await computePeaks(entry.audioBlob, 240);
      const trackId = editor.addTrack({ name: entry.title });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const clipId = editor.addClipToTrack({
        trackId,
        label: entry.title,
        audioBlob: entry.audioBlob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec: 0,
        color: trackColor,
        libraryEntryId: entry.id,
      });
      editor.cachePeaks(clipId, peaks);
    } catch (e) {
      logError('details', `Send to editor failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleDownload = () => {
    if (!entry) return;
    const url = getAudioUrl(entry);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!selectedId || !entry) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0a080f] text-zinc-700 italic text-[10px] font-mono uppercase tracking-widest">
        Click a track in the LIBRARY to inspect its metadata.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0a080f] p-3">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-bold text-zinc-100 truncate">{entry.title}</h3>
          <p className="text-[9px] font-mono text-zinc-500 truncate">
            {entry.prompt || <em className="text-zinc-700">No prompt</em>}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={handleAuditionInEngine} className="btn-ghost text-[9px] py-1 flex items-center gap-1" title="Load + play in global player">
            <Disc className="w-3 h-3 text-purple-300" /> AUDITION
          </button>
          <button onClick={handleSendToNewEditorTrack} className="btn-ghost text-[9px] py-1 flex items-center gap-1" title="Create a new editor track for this clip">
            <Scissors className="w-3 h-3 text-purple-300" /> TO EDITOR
          </button>
          <button onClick={handleDownload} className="btn-ghost text-[9px] py-1 flex items-center gap-1" title="Download the audio file">
            <Download className="w-3 h-3 text-purple-300" /> DOWNLOAD
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6">
        <div>
          <Row icon={Database} label="Entry ID" value={entry.id} />
          <Row icon={FileAudio} label="Filename" value={entry.title} />
          <Row icon={Music} label="Source" value={entry.source} />
          <Row icon={Layers} label="Model" value={entry.model} />
          <Row icon={Hash} label="Seed" value={entry.seed === -1 ? 'random' : String(entry.seed)} />
          <Row icon={Hash} label="Steps" value={String(entry.steps)} />
          <Row icon={Hash} label="CFG" value={entry.cfg.toFixed(2)} />
          <Row icon={Clock} label="Duration" value={fmtDuration(entry.duration)} />
        </div>
        <div>
          <Row icon={Calendar} label="Created" value={fmtDate(entry.timestamp)} />
          <Row icon={FileAudio} label="MIME" value={entry.mimeType} />
          <Row icon={FileAudio} label="Size" value={fmtSize(entry.audioBlob.size)} />
          <Row icon={Star} label="Favorite" value={entry.favorite ? 'yes' : 'no'} />
          <Row icon={Star} label="Rating" value={entry.rating ?? '—'} />
          <Row icon={Tag} label="Tags" value={entry.tags.length ? entry.tags.join(', ') : '—'} />
          <Row icon={FileAudio} label="Neg. prompt" value={entry.negativePrompt || '—'} />
          <Row icon={Send} label="Notes" value={entry.notes || '—'} mono={false} />
        </div>
      </div>

      <div className="mt-3 p-2 rounded border border-white/5 bg-black/40">
        <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest mb-1">PROMPT</p>
        <p className="text-[11px] text-zinc-200 leading-relaxed">{entry.prompt || <em className="text-zinc-600">No prompt was used for this generation.</em>}</p>
      </div>
    </div>
  );
};
