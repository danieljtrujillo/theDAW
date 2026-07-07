/** Library tab: browse and play the desktop's library over REST. Standalone —
 *  needs no desktop browser open. Audio streams to the phone's own <audio>. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { Scroller } from '../ui/Scroller';
import { useLibraryStore } from '../../state/libraryStore';
import type { LibraryEntry } from '../../state/libraryStore';

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MobileLibrary() {
  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const loading = useLibraryStore((s) => s.loading);
  const load = useLibraryStore((s) => s.load);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);

  const [query, setQuery] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!loaded && !loading) void load();
  }, [loaded, loading, load]);

  const filtered = useMemo(() => {
    const audio = entries.filter((e) => (e.kind ?? 'audio') === 'audio');
    const q = query.trim().toLowerCase();
    if (!q) return audio;
    return audio.filter(
      (e) =>
        e.title.toLowerCase().includes(q) || (e.prompt ?? '').toLowerCase().includes(q),
    );
  }, [entries, query]);

  function toggle(entry: LibraryEntry): void {
    const el = audioRef.current;
    if (!el) return;
    if (playingId === entry.id) {
      if (el.paused) void el.play();
      else el.pause();
      return;
    }
    el.src = getAudioUrl(entry);
    setPlayingId(entry.id);
    void el.play().catch(() => setPlayingId((cur) => (cur === entry.id ? null : cur)));
  }

  return (
    <>
      <label className="m-search">
        <span className="sr-only">Search library</span>
        <input
          id="m-lib-search"
          name="library-search"
          type="search"
          placeholder="Search library…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <Scroller>
        {filtered.length === 0 ? (
          <p className="m-empty">
            {loading ? 'Loading library…' : loaded ? 'No tracks found.' : 'Connecting…'}
          </p>
        ) : (
          <ul className="m-list">
            {filtered.map((entry) => {
              const isPlaying = playingId === entry.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={`m-row${isPlaying ? ' is-playing' : ''}`}
                    onClick={() => toggle(entry)}
                  >
                    <span className="m-row-play" aria-hidden="true">
                      {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                    </span>
                    <span className="m-row-body">
                      <span className="m-row-title">{entry.title || 'Untitled'}</span>
                      <span className="m-row-sub">
                        {[entry.model, fmtDuration(entry.duration)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Scroller>
      {/* One shared element; onEnded clears the row highlight. */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingId(null)}
        onPause={() => {
          /* keep highlight so the row shows a resumable paused state */
        }}
      />
    </>
  );
}
