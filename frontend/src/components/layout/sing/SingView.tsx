import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlignLeft,
  Download,
  Loader2,
  MicVocal,
  Pause,
  Pencil,
  Play,
  Trash2,
  Undo2,
  Upload,
  Wand2,
} from 'lucide-react';
import { useLibraryStore } from '../../../state/libraryStore';
import { SING_LANGUAGES, useLyricsStore } from '../../../state/lyricsStore';
import { lyricsExportUrl } from '../../../lib/lyricsClient';
import { usePlayAlong } from '../score/playAlong/usePlayAlongClock';
import { LyricsScroller, type LyricsScrollerHandle } from './LyricsScroller';
import { LyricsEditor } from './LyricsEditor';

const PitchLane = React.lazy(() => import('./PitchLane'));

const SOURCE_LABELS: Record<string, string> = {
  '': 'untimed',
  manual: 'pasted',
  suno: 'suno',
  tags: 'tags',
  embedded: 'embedded',
  notes: 'notes',
  transcribed: 'transcribed',
  aligned: 'aligned',
  lrc: 'lrc',
  tap: 'tapped',
};

const isEditableTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

/**
 * SING: karaoke for the selected library song. The lyrics follow the track
 * word by word on the same latency-compensated clock the SCORE tab uses;
 * TAP stamps line starts live; whisper can transcribe or align pasted text;
 * LRC goes in and out; the pitch lane scores the sung melody.
 */
export const SingView: React.FC = () => {
  const entry = useLibraryStore((s) => (s.selectedEntryId ? s.entries.find((e) => e.id === s.selectedEntryId) ?? null : null));
  const doc = useLyricsStore((s) => s.doc);
  const loading = useLyricsStore((s) => s.loading);
  const dirty = useLyricsStore((s) => s.dirty);
  const saving = useLyricsStore((s) => s.saving);
  const error = useLyricsStore((s) => s.error);
  const job = useLyricsStore((s) => s.job);
  const follow = useLyricsStore((s) => s.follow);
  const tapMode = useLyricsStore((s) => s.tapMode);
  const showPitch = useLyricsStore((s) => s.showPitch);
  const transcription = useLyricsStore((s) => s.transcription);
  const notesCandidate = useLyricsStore((s) => s.notesCandidate);
  const persisted = useLyricsStore((s) => s.persisted);
  const language = useLyricsStore((s) => s.language);
  const autoAlign = useLyricsStore((s) => s.autoAlign);

  const [editing, setEditing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFmt, setImportFmt] = useState<'lrc' | 'txt'>('lrc');
  const [importDraft, setImportDraft] = useState('');
  const [exportOpen, setExportOpen] = useState(false);

  const scrollerRef = useRef<LyricsScrollerHandle | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const followRef = useRef(follow);
  followRef.current = follow;
  const posRef = useRef(0);
  const activeLineRef = useRef(-1);

  const entryId = entry?.id ?? null;
  const isAudio = !entry?.kind || entry.kind === 'audio';

  useEffect(() => {
    void useLyricsStore.getState().probeTranscription();
    return () => {
      void useLyricsStore.getState().flush();
    };
  }, []);

  useEffect(() => {
    setEditing(false);
    setImportOpen(false);
    setExportOpen(false);
    if (entryId && isAudio) void useLyricsStore.getState().load(entryId);
  }, [entryId, isAudio]);

  const handle = usePlayAlong(entry && isAudio ? entry : null, (sec) => {
    const d = docRef.current;
    const pos = sec * 1000 + (d?.offset_ms ?? 0);
    posRef.current = pos;
    if (followRef.current) scrollerRef.current?.setPosition(pos);
  });

  useEffect(() => {
    if (!handle.isSameTrack) scrollerRef.current?.clear();
  }, [handle.isSameTrack, doc]);

  // Pausing is a natural save point for tap timings.
  useEffect(() => {
    if (!handle.isPlaying && useLyricsStore.getState().dirty) void useLyricsStore.getState().saveNow();
  }, [handle.isPlaying]);

  // TAP: Space / Enter stamps the next line; Backspace undoes. Captured before
  // any global transport shortcut, and never from a text field.
  useEffect(() => {
    if (!tapMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const s = useLyricsStore.getState();
      if ((e.key === ' ' || e.key === 'Enter') && handle.isSameTrack) {
        e.preventDefault();
        e.stopPropagation();
        s.tap(posRef.current);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        s.undoTap();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tapMode, handle.isSameTrack]);

  const seekToLine = useCallback((lineIdx: number) => {
    const d = docRef.current;
    const line = d?.lines[lineIdx];
    if (!d || !line || line.start_ms === null) return;
    const sec = Math.max(0, (line.start_ms - d.offset_ms) / 1000);
    if (!handle.isSameTrack) {
      void handle.onTransport().then(() => handle.seek(sec));
      return;
    }
    handle.seek(sec);
    handle.clock.reset();
    posRef.current = line.start_ms;
    scrollerRef.current?.setPosition(line.start_ms);
  }, [handle]);

  const applyImport = async () => {
    const content = importDraft.trim();
    if (!content) return;
    await useLyricsStore.getState().importText(importFmt, content);
    setImportDraft('');
    setImportOpen(false);
  };

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const fmt: 'lrc' | 'txt' = /\.lrc$/i.test(file.name) || /^\s*\[\d{1,2}:\d{2}/m.test(text) ? 'lrc' : 'txt';
    await useLyricsStore.getState().importText(fmt, text);
    setImportOpen(false);
  };

  if (!entry) {
    return (
      <div className="h-full flex items-center justify-center text-[10px] font-mono text-zinc-500">
        Select a song in the library to sing along.
      </div>
    );
  }
  if (!isAudio) {
    return (
      <div className="h-full flex items-center justify-center text-[10px] font-mono text-zinc-500">
        SING needs an audio entry.
      </div>
    );
  }

  const stats = doc?.stats ?? null;
  const pct = stats && stats.total > 0 ? Math.round((100 * stats.matched) / stats.total) : null;
  const mismatched = stats?.mismatched ?? 0;
  const hasText = !!doc?.text.trim();
  const hasTimings = !!doc?.lines.some((l) => l.start_ms !== null);
  const busy = !!job;
  const transcribeLabel = transcription === 'missing' ? 'INSTALL TRANSCRIPTION' : 'TRANSCRIBE';
  const store = useLyricsStore.getState;
  const runOrInstall = (which: 'transcribe' | 'align') => {
    if (transcription === 'missing') return void store().installTranscription();
    return which === 'transcribe' ? void store().runTranscribe() : void store().runAlign();
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#07050a] text-zinc-200">
      {/* Header */}
      <div className="h-8 shrink-0 border-b border-white/5 bg-black/30 flex items-center gap-1.5 px-2 text-[9px] font-mono">
        <MicVocal className="w-3.5 h-3.5 text-rose-300 shrink-0" />
        <span className="truncate text-zinc-300" title={entry.title}>{entry.title}</span>
        {doc && (
          <span className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1 text-rose-200" title="Where these lyrics came from">
            {SOURCE_LABELS[doc.source] ?? doc.source}
          </span>
        )}
        {pct !== null && (
          <span
            className={`shrink-0 rounded border px-1 ${pct < 60 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'}`}
            title={`${stats?.matched} of ${stats?.total} words matched whisper's transcript`}
          >
            {pct}% matched
          </span>
        )}
        {mismatched > 0 && (
          <span
            className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-amber-200"
            title="Whisper heard different words at these places. They are underlined in the lyrics; hover one to read what was heard."
          >
            {mismatched} {mismatched === 1 ? 'word differs' : 'words differ'}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1" onClick={() => setEditing((v) => !v)} disabled={!doc} title="Edit the lyrics text (unchanged lines keep their timings)">
          <Pencil className="w-3 h-3" /> EDIT
        </button>
        <button type="button" className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40" onClick={() => runOrInstall('transcribe')} disabled={busy || !doc} title="Let whisper write the lyrics from the vocal (the first run installs the sidecar)">
          {job?.kind === 'transcribe' || job?.kind === 'install' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />} {transcribeLabel}
        </button>
        <label htmlFor="sing-language" className="sr-only">Lyrics language for whisper</label>
        <select
          id="sing-language"
          name="sing-language"
          className="form-select text-[8px] px-1 py-0.5 max-w-24"
          value={language}
          onChange={(e) => store().setLanguage(e.target.value)}
          disabled={busy}
          title={doc?.language && doc.language !== 'en' ? `Language for TRANSCRIBE / ALIGN (this document: ${doc.language})` : 'Language for TRANSCRIBE / ALIGN; Auto lets whisper detect it'}
        >
          {SING_LANGUAGES.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
        <button type="button" className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40" onClick={() => runOrInstall('align')} disabled={busy || !hasText} title="Keep these words, take the timing from the vocal: whisper listens, every line and word gets a time">
          {job?.kind === 'align' ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlignLeft className="w-3 h-3" />} ALIGN
        </button>
        <button type="button" className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1" onClick={() => setImportOpen((v) => !v)} aria-expanded={importOpen} aria-controls="sing-import-panel" title="Import an LRC or TXT file, or paste one">
          <Upload className="w-3 h-3" /> IMPORT
        </button>
        <span className="relative">
          <button type="button" className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40" onClick={() => setExportOpen((v) => !v)} disabled={!hasText} aria-haspopup="menu" aria-expanded={exportOpen} aria-controls="sing-export-menu" title="Download the lyrics as LRC or TXT">
            <Download className="w-3 h-3" /> EXPORT
          </button>
          {exportOpen && (
            <div id="sing-export-menu" role="menu" className="absolute right-0 top-full mt-1 z-20 min-w-36 rounded border border-white/10 bg-[#0a080f] p-1 shadow-xl">
              {([
                ['LRC', lyricsExportUrl(entry.id, 'lrc', false)],
                ['LRC + word tags', lyricsExportUrl(entry.id, 'lrc', true)],
                ['TXT', lyricsExportUrl(entry.id, 'txt', false)],
              ] as Array<[string, string]>).map(([label, href]) => (
                <a key={label} role="menuitem" href={href} download className="block rounded px-2 py-1 text-[9px] hover:bg-white/10" onClick={() => setExportOpen(false)}>
                  {label}
                </a>
              ))}
            </div>
          )}
        </span>
        <input id="sing-pitch" name="sing-pitch" type="checkbox" className="accent-rose-400" checked={showPitch} onChange={(e) => store().setShowPitch(e.target.checked)} />
        <label htmlFor="sing-pitch" className="cursor-pointer select-none" title="Show the pitch lane: the vocal's melody with your sung pitch over it">PITCH</label>
        <button type="button" className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40" onClick={() => void store().removeTimings()} disabled={!persisted || busy} title="Delete the timed document (lyrics.json); the plain text stays on the entry">
          <Trash2 className="w-3 h-3" /> TIMINGS
        </button>
      </div>

      {(job || error) && (
        <div className="shrink-0 flex items-center gap-2 border-b border-white/5 bg-black/20 px-2 py-1 text-[9px] font-mono">
          {job && (
            <>
              <Loader2 className="w-3 h-3 animate-spin text-rose-300" />
              <span className="text-zinc-300">{job.kind}: {job.message || job.status}</span>
              <div className="h-1 w-32 overflow-hidden rounded bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)} aria-label={`${job.kind} progress`}>
                <div className="h-full bg-rose-400" style={{ width: `${Math.round(job.progress * 100)}%` }} />
              </div>
            </>
          )}
          {error && (
            <>
              <span className="text-rose-300">{error}</span>
              <button type="button" className="btn-ghost text-[8px] py-0.5 px-1" onClick={() => store().clearError()} aria-label="Dismiss the error">×</button>
            </>
          )}
        </div>
      )}

      {importOpen && (
        <div id="sing-import-panel" className="shrink-0 border-b border-white/5 bg-black/20 p-2 flex flex-col gap-1.5 text-[9px] font-mono">
          <label htmlFor="sing-import-text" className="text-zinc-500">Paste LRC or plain lyrics</label>
          <textarea id="sing-import-text" name="sing-import-text" className="h-20 w-full resize-none rounded border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-zinc-100" value={importDraft} onChange={(e) => setImportDraft(e.target.value)} spellCheck={false} />
          <div className="flex flex-wrap items-center gap-2">
            <input id="sing-import-fmt-lrc" name="sing-import-fmt" type="radio" className="accent-rose-400" checked={importFmt === 'lrc'} onChange={() => setImportFmt('lrc')} />
            <label htmlFor="sing-import-fmt-lrc">LRC</label>
            <input id="sing-import-fmt-txt" name="sing-import-fmt" type="radio" className="accent-rose-400" checked={importFmt === 'txt'} onChange={() => setImportFmt('txt')} />
            <label htmlFor="sing-import-fmt-txt">TXT</label>
            <button type="button" className="btn-ghost text-[8px] py-1 px-2 border border-rose-500/40 text-rose-200" onClick={() => void applyImport()} disabled={!importDraft.trim()}>IMPORT PASTED</button>
            <label htmlFor="sing-import-file" className="text-zinc-500">or a file</label>
            <input id="sing-import-file" name="sing-import-file" type="file" accept=".lrc,.txt" className="text-[9px]" onChange={(e) => void onImportFile(e.target.files?.[0])} />
            <button type="button" className="btn-ghost text-[8px] py-1 px-2 ml-auto" onClick={() => setImportOpen(false)}>CLOSE</button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {showPitch && doc && (
          <Suspense fallback={<div className="h-28 shrink-0 border-b border-white/10" />}>
            <PitchLane entryId={entry.id} getPosMs={() => posRef.current} activeLineRef={activeLineRef} />
          </Suspense>
        )}
        <div className="sing-stage flex-1 min-h-0 relative">
          {loading || !doc ? (
            <div className="h-full flex items-center justify-center text-[10px] font-mono text-zinc-500">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'No lyrics loaded.'}
            </div>
          ) : editing ? (
            <LyricsEditor
              initialText={doc.text}
              onApply={(text) => {
                setEditing(false);
                void store().setText(text);
              }}
              onImportLrc={(content) => {
                setEditing(false);
                void store().importText('lrc', content);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : !hasText ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-[10px] font-mono text-zinc-400">
              <div className="text-zinc-500">No lyrics yet for this song.</div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button type="button" className="btn-ghost text-[10px] py-2 px-3 border border-rose-500/40 text-rose-200 flex items-center gap-1" onClick={() => setEditing(true)}>
                  <Pencil className="w-3.5 h-3.5" /> PASTE LYRICS
                </button>
                <button type="button" className="btn-ghost text-[10px] py-2 px-3 border border-purple-500/40 text-purple-200 flex items-center gap-1 disabled:opacity-40" onClick={() => runOrInstall('transcribe')} disabled={busy}>
                  <Wand2 className="w-3.5 h-3.5" /> {transcribeLabel}
                </button>
                <button type="button" className="btn-ghost text-[10px] py-2 px-3 border border-white/15 flex items-center gap-1" onClick={() => setImportOpen(true)}>
                  <Upload className="w-3.5 h-3.5" /> IMPORT LRC
                </button>
              </div>
              {notesCandidate && (
                <button type="button" className="text-[9px] text-zinc-500 underline hover:text-zinc-200" onClick={() => void store().useNotesAsLyrics()} title="The entry's notes look like lyrics">
                  Use notes as lyrics
                </button>
              )}
            </div>
          ) : (
            <LyricsScroller
              ref={scrollerRef}
              doc={doc}
              tapMode={tapMode}
              onSeekLine={seekToLine}
              onSelectTapTarget={(i) => useLyricsStore.setState({ lastTapped: i - 1 })}
              onNudge={(i, d) => store().nudge(i, d)}
              onActiveLine={(i) => {
                activeLineRef.current = i;
              }}
            />
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 h-8 border-t border-white/10 bg-[#0a080f] flex items-center gap-2 px-2 text-[10px] font-mono text-zinc-300">
        <button type="button" onClick={() => void handle.onTransport()} className="p-1 rounded hover:bg-white/10" title={handle.isSameTrack && handle.isPlaying ? `Pause ${entry.title}` : `Play ${entry.title}`} aria-label={handle.isSameTrack && handle.isPlaying ? `Pause ${entry.title}` : `Play ${entry.title}`}>
          {handle.isSameTrack && handle.isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 text-rose-300" />}
        </button>
        <input id="sing-follow" name="sing-follow" type="checkbox" className="accent-rose-400" checked={follow} onChange={(e) => store().setFollow(e.target.checked)} />
        <label htmlFor="sing-follow" className="cursor-pointer select-none" title="Highlight and scroll the lyrics with the track">FOLLOW</label>
        <input id="sing-auto-align" name="sing-auto-align" type="checkbox" className="accent-rose-400" checked={autoAlign} onChange={(e) => store().setAutoAlign(e.target.checked)} />
        <label htmlFor="sing-auto-align" className="cursor-pointer select-none" title="When a song opens with lyrics but no timings, run ALIGN automatically (times your words against the vocal)">AUTO</label>
        <input id="sing-tap" name="sing-tap" type="checkbox" className="accent-rose-400" checked={tapMode} onChange={(e) => store().setTapMode(e.target.checked)} disabled={!hasText} />
        <label htmlFor="sing-tap" className="cursor-pointer select-none" title="Tap mode: Space or Enter stamps the next untimed line at the current time; Backspace undoes">TAP</label>
        <button type="button" className="btn-ghost text-[8px] py-0.5 px-2 border border-rose-500/40 text-rose-200 disabled:opacity-40" onClick={() => store().tap(posRef.current)} disabled={!tapMode || !handle.isSameTrack} aria-label="Stamp the next line at the current time" title="Stamp the next untimed line now (Space)">
          TAP
        </button>
        <button type="button" className="btn-ghost text-[8px] py-0.5 px-1.5 flex items-center gap-1 disabled:opacity-40" onClick={() => store().undoTap()} disabled={!tapMode} aria-label="Undo the last tap" title="Undo the last tap (Backspace)">
          <Undo2 className="w-3 h-3" /> UNDO
        </button>
        {handle.otherTrackLoaded && (
          <span className="text-amber-300/90" title="The player is holding a different track. Press play here to load this song.">
            OTHER TRACK
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <label htmlFor="sing-offset" className="text-zinc-500 select-none" title="Shift every lyric: positive shows the words later">OFFSET ms</label>
          <input id="sing-offset" name="sing-offset" type="number" step={10} value={doc?.offset_ms ?? 0} onChange={(e) => store().setOffset(Number(e.target.value) || 0)} disabled={!doc} className="w-16 form-select text-[10px] px-1 py-0.5 tabular-nums" />
          <span className={`min-w-14 text-right ${saving ? 'text-zinc-400' : dirty ? 'text-amber-300' : hasTimings || persisted ? 'text-emerald-300/80' : 'text-zinc-600'}`} aria-live="polite">
            {saving ? 'saving…' : dirty ? 'unsaved' : persisted ? 'saved' : ''}
          </span>
        </span>
      </div>
    </div>
  );
};

export default SingView;
