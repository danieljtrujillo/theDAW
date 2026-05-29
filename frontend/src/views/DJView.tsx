/**
 * DJ tab — VirtualDJ-style 2-deck mixer + VJ performance bridge.
 *
 * Two decks side-by-side, a crossfader, a master transport that stays
 * in sync with the VJ tab via the shared vjPlaybackBus, and a setlist
 * sidebar wired to the persistent setlistStore.
 *
 * The previous version's per-deck play buttons were purely cosmetic
 * local booleans, which is why play/pause never stayed in sync with
 * the VJ view. This version adds a single MASTER TRANSPORT that is the
 * source of truth for the live performance: it subscribes to
 * vjPlaybackBus so the icon always reflects the real VJ state, and its
 * button routes through playVj()/pauseVj()/toggleVjPlayback().
 *
 * It also closes the "disjointed" gap between the DJ setlists and the
 * VJ performance: every deck has a SEND-TO-VJ button (pushes the loaded
 * track to the VJ archive bucket) and the sidebar has a prominent
 * "Send SET to VJ" action that maps the active setlist's entries to the
 * VJ side via vjSetBus. If the VJ tab isn't open yet, the SET is
 * buffered and delivered the moment it mounts.
 */
import React, { useEffect, useState } from 'react';
import {
  Disc, Play, Pause, ListMusic, Plus, Save, Trash2, Cast, Radio, Music2,
} from 'lucide-react';
import { useSetlistStore } from '../state/setlistStore';
import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import {
  toggleVjPlayback, subscribeToVjPlaybackState, isVjPlaybackActive,
  type VjPlaybackState,
} from '../state/vjPlaybackBus';
import {
  sendSetToVj, sendTrackToVj, isVjSetTargetActive, type VjSetItem,
} from '../state/vjSetBus';

export const DJView: React.FC = () => {
  const [deckATrack, setDeckATrack] = useState<string | null>(null);
  const [deckBTrack, setDeckBTrack] = useState<string | null>(null);
  const [deckAPlaying, setDeckAPlaying] = useState(false);
  const [deckBPlaying, setDeckBPlaying] = useState(false);
  const [crossfader, setCrossfader] = useState(0); // -1 A, 0 center, +1 B
  const [deckAPitch, setDeckAPitch] = useState(0);
  const [deckBPitch, setDeckBPitch] = useState(0);
  const [deckAEqLow, setDeckAEqLow] = useState(0);
  const [deckAEqMid, setDeckAEqMid] = useState(0);
  const [deckAEqHigh, setDeckAEqHigh] = useState(0);
  const [deckBEqLow, setDeckBEqLow] = useState(0);
  const [deckBEqMid, setDeckBEqMid] = useState(0);
  const [deckBEqHigh, setDeckBEqHigh] = useState(0);

  // Master transport — the single source of truth for the live
  // performance, mirrored from the VJ playback bus so the DJ tab and
  // the VJ tab never disagree about play/pause.
  const [vjState, setVjState] = useState<VjPlaybackState>('unknown');
  const [vjOpen, setVjOpen] = useState<boolean>(isVjPlaybackActive());
  const [flash, setFlash] = useState<string | null>(null);

  const entries = useLibraryStore((s) => s.entries);
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const createSetlist = useSetlistStore((s) => s.create);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setActive = useSetlistStore((s) => s.setActive);
  const appendToSet = useSetlistStore((s) => s.append);

  const activeSet = activeId ? setlists[activeId] : null;

  // Keep the master transport icon synced with the real VJ state.
  useEffect(() => {
    const unsub = subscribeToVjPlaybackState((s) => {
      setVjState(s);
      setVjOpen(isVjPlaybackActive());
    });
    return unsub;
  }, []);

  // Auto-dismiss the confirmation flash.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const trackById = (id: string | null): LibraryEntry | null =>
    (id ? entries.find((e) => e.id === id) ?? null : null);
  const deckATitle = trackById(deckATrack)?.title ?? 'Empty deck';
  const deckBTitle = trackById(deckBTrack)?.title ?? 'Empty deck';

  const handleAddCurrentToSet = (which: 'A' | 'B') => {
    if (!activeId) return;
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    appendToSet(activeId, [{ entryId: track.id, label: track.title, kind: 'audio' }]);
  };

  const handleSendDeckToVj = (which: 'A' | 'B') => {
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    const item: VjSetItem = {
      entryId: track.id,
      label: track.title,
      url: track.audioUrl,
      kind: 'audio',
    };
    sendTrackToVj(item);
    setFlash(
      isVjSetTargetActive()
        ? `Sent "${track.title}" to VJ`
        : `Queued "${track.title}" — opens with VJ tab`,
    );
  };

  const handleSendSetToVj = () => {
    if (!activeSet) return;
    const items: VjSetItem[] = activeSet.entries.map((e) => {
      const entry = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
      return {
        entryId: e.entryId,
        label: e.label,
        url: entry?.audioUrl ?? e.url,
        kind: e.kind ?? 'audio',
      };
    });
    sendSetToVj({ setId: activeSet.id, name: activeSet.name, items });
    setFlash(
      isVjSetTargetActive()
        ? `Sent SET "${activeSet.name}" (${items.length}) to VJ`
        : `Queued SET "${activeSet.name}" — opens with VJ tab`,
    );
  };

  const masterPlaying = vjState === 'playing';

  return (
    <div className="absolute inset-0 flex bg-[#07050a] text-white overflow-hidden">
      {/* Decks + crossfader */}
      <div className="flex-1 flex flex-col p-3 gap-3 min-w-0">
        {/* Master transport — synced with the VJ tab */}
        <div className="shrink-0 bg-black/60 border border-white/10 rounded px-3 py-2 flex items-center gap-3">
          <button
            onClick={toggleVjPlayback}
            className={`flex items-center gap-2 px-3 py-1.5 rounded font-black uppercase tracking-widest text-[10px] transition-colors ${
              masterPlaying
                ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/50'
                : 'bg-fuchsia-500/15 text-fuchsia-200 border border-fuchsia-500/40 hover:bg-fuchsia-500/25'
            }`}
            title="Master transport — drives the VJ performance (stays in sync with the VJ tab)"
          >
            {masterPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            {masterPlaying ? 'Pause Live' : 'Play Live'}
          </button>
          <div className="flex items-center gap-1.5 text-[9px] font-mono">
            <Radio className={`w-3 h-3 ${vjOpen ? 'text-emerald-400' : 'text-zinc-600'}`} />
            <span className={vjOpen ? 'text-emerald-300' : 'text-zinc-600'}>
              {vjOpen ? `VJ LINKED · ${vjState.toUpperCase()}` : 'VJ TAB CLOSED'}
            </span>
          </div>
          {flash && (
            <span className="ml-auto text-[9px] font-mono text-cyan-300 truncate max-w-[40%]">{flash}</span>
          )}
        </div>

        <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
          <Deck
            label="DECK A"
            accent="purple"
            trackTitle={deckATitle}
            isPlaying={deckAPlaying}
            onPlay={() => setDeckAPlaying((p) => !p)}
            pitch={deckAPitch}
            onPitch={setDeckAPitch}
            eqLow={deckAEqLow}
            eqMid={deckAEqMid}
            eqHigh={deckAEqHigh}
            onEq={(b, v) => (b === 'low' ? setDeckAEqLow(v) : b === 'mid' ? setDeckAEqMid(v) : setDeckAEqHigh(v))}
            onLoadId={setDeckATrack}
            entries={entries}
            onAddToSet={() => handleAddCurrentToSet('A')}
            onSendToVj={() => handleSendDeckToVj('A')}
            hasTrack={!!deckATrack}
            setLoaded={!!activeSet}
          />
          <Deck
            label="DECK B"
            accent="cyan"
            trackTitle={deckBTitle}
            isPlaying={deckBPlaying}
            onPlay={() => setDeckBPlaying((p) => !p)}
            pitch={deckBPitch}
            onPitch={setDeckBPitch}
            eqLow={deckBEqLow}
            eqMid={deckBEqMid}
            eqHigh={deckBEqHigh}
            onEq={(b, v) => (b === 'low' ? setDeckBEqLow(v) : b === 'mid' ? setDeckBEqMid(v) : setDeckBEqHigh(v))}
            onLoadId={setDeckBTrack}
            entries={entries}
            onAddToSet={() => handleAddCurrentToSet('B')}
            onSendToVj={() => handleSendDeckToVj('B')}
            hasTrack={!!deckBTrack}
            setLoaded={!!activeSet}
          />
        </div>

        {/* Master crossfader */}
        <div className="shrink-0 bg-black/60 border border-white/10 rounded p-3 flex items-center gap-3">
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 w-8 text-right">A</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={crossfader}
            onChange={(e) => setCrossfader(parseFloat(e.target.value))}
            className="flex-1 h-3 accent-fuchsia-500 cursor-col-resize"
            title="Crossfade between Deck A and Deck B"
          />
          <span className="text-[10px] font-black uppercase tracking-widest text-cyan-300 w-8 text-left">B</span>
          <span className="text-[9px] font-mono text-zinc-500 ml-2 w-12 text-right">
            {crossfader < -0.05 ? `A ${Math.round((1 + crossfader) * 100)}%` : crossfader > 0.05 ? `B ${Math.round((1 - crossfader) * -100 + 100)}%` : 'CENTER'}
          </span>
        </div>
      </div>

      {/* Setlist sidebar */}
      <aside className="shrink-0 w-72 bg-[#0a080f] border-l border-white/5 flex flex-col">
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/5 bg-purple-500/4">
          <div className="flex items-center gap-1.5">
            <ListMusic className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-200">Setlists</span>
          </div>
          <button
            onClick={() => createSetlist(`Set ${new Date().toLocaleDateString()}`)}
            className="p-1 rounded text-purple-300 hover:bg-purple-500/15 hover:text-purple-100 transition-colors"
            title="New setlist"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {Object.values(setlists).length === 0 ? (
            <div className="p-3 text-[9px] font-mono text-zinc-600 leading-relaxed">
              No setlists yet. Click <Plus className="inline w-3 h-3" /> to create one, then use a deck's <Save className="inline w-3 h-3" /> button to push the loaded track into the active set. Send the whole set to the VJ tab with the button below.
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {Object.values(setlists).sort((a, b) => b.updatedAt - a.updatedAt).map((s) => (
                <li
                  key={s.id}
                  className={`px-3 py-2 cursor-pointer transition-colors ${s.id === activeId ? 'bg-purple-500/10' : 'hover:bg-white/5'}`}
                  onClick={() => setActive(s.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-zinc-200 truncate">{s.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeSetlist(s.id); }}
                      className="p-0.5 text-zinc-600 hover:text-rose-400 transition-colors"
                      title="Delete setlist"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-[8px] font-mono text-zinc-600 mt-0.5">
                    {s.entries.length} track{s.entries.length === 1 ? '' : 's'} · {new Date(s.updatedAt).toLocaleDateString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Send-to-VJ action */}
        <div className="shrink-0 border-t border-white/5 p-2">
          <button
            onClick={handleSendSetToVj}
            disabled={!activeSet || activeSet.entries.length === 0}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded font-black uppercase tracking-widest text-[10px] bg-cyan-500/15 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/25 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="Push the active setlist into the VJ performance bucket"
          >
            <Cast className="w-3.5 h-3.5" />
            Send SET to VJ
          </button>
          <div className="mt-1 text-center text-[8px] font-mono text-zinc-600">
            {isVjSetTargetActive() ? 'VJ tab linked — delivers instantly' : 'VJ tab closed — will deliver on open'}
          </div>
        </div>

        {/* Active set entries */}
        {activeSet && (
          <div className="shrink-0 max-h-48 overflow-y-auto border-t border-white/5 bg-black/30">
            <div className="px-3 py-1.5 border-b border-white/5 text-[8px] font-mono text-zinc-600 uppercase tracking-widest flex items-center justify-between">
              <span>{activeSet.name}</span>
              <Music2 className="w-3 h-3 text-emerald-400" />
            </div>
            {activeSet.entries.length === 0 ? (
              <div className="p-2 text-[9px] text-zinc-700 italic">
                Empty — Save a loaded deck track here.
              </div>
            ) : (
              <ol className="text-[9px] font-mono">
                {activeSet.entries.map((e, i) => (
                  <li key={i} className="px-3 py-1 border-b border-white/3 text-zinc-400 truncate">
                    {String(i + 1).padStart(2, '0')}. {e.label}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </aside>
    </div>
  );
};

interface DeckProps {
  label: string;
  accent: 'purple' | 'cyan';
  trackTitle: string;
  isPlaying: boolean;
  onPlay: () => void;
  pitch: number;
  onPitch: (v: number) => void;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  onEq: (band: 'low' | 'mid' | 'high', v: number) => void;
  onLoadId: (id: string | null) => void;
  entries: Array<{ id: string; title: string }>;
  onAddToSet: () => void;
  onSendToVj: () => void;
  hasTrack: boolean;
  setLoaded: boolean;
}

const Deck: React.FC<DeckProps> = ({
  label, accent, trackTitle, isPlaying, onPlay, pitch, onPitch,
  eqLow, eqMid, eqHigh, onEq, onLoadId, entries, onAddToSet, onSendToVj,
  hasTrack, setLoaded,
}) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const accentBorder = accent === 'purple' ? 'border-purple-500/40' : 'border-cyan-500/40';
  const accentBg = accent === 'purple' ? 'bg-purple-500/10' : 'bg-cyan-500/10';

  return (
    <div className={`flex flex-col bg-black/40 border ${accentBorder} rounded overflow-hidden`}>
      <div className={`shrink-0 px-3 py-1.5 ${accentBg} border-b ${accentBorder} flex items-center justify-between`}>
        <div className="flex items-center gap-1.5">
          <Disc className={`w-3.5 h-3.5 ${accentText} ${isPlaying ? 'animate-spin' : ''}`} />
          <span className={`text-[10px] font-black uppercase tracking-widest ${accentText}`}>{label}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onSendToVj}
            disabled={!hasTrack}
            className="p-1 text-zinc-500 hover:text-cyan-300 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title={hasTrack ? 'Send this track to the VJ performance' : 'Load a track to enable Send-to-VJ'}
          >
            <Cast className="w-3 h-3" />
          </button>
          <button
            onClick={onAddToSet}
            disabled={!setLoaded || !hasTrack}
            className="p-1 text-zinc-500 hover:text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title={setLoaded ? 'Append loaded track to active setlist' : 'Activate a setlist to enable Save'}
          >
            <Save className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Track display */}
      <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
        <select
          value={entries.find((e) => e.title === trackTitle)?.id ?? ''}
          onChange={(e) => onLoadId(e.target.value || null)}
          className="bg-black/40 border border-white/10 text-[10px] font-mono text-zinc-200 px-2 py-1 rounded cursor-pointer"
        >
          <option value="">— Load track —</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>{e.title}</option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <button
            onClick={onPlay}
            className={`p-2 rounded ${isPlaying ? 'bg-red-500/20 text-red-300 border border-red-500/40' : `${accentBg} ${accentText} border ${accentBorder}`}`}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
          <div className="flex-1 text-[10px] font-mono text-zinc-400 truncate">{trackTitle}</div>
        </div>

        {/* EQ */}
        <div className="grid grid-cols-3 gap-1 mt-1">
          {([['low', eqLow], ['mid', eqMid], ['high', eqHigh]] as const).map(([band, value]) => (
            <div key={band} className="flex flex-col items-center gap-0.5">
              <input
                type="range" min={-12} max={12} step={0.5} value={value}
                onChange={(e) => onEq(band, parseFloat(e.target.value))}
                className={`w-full h-1 cursor-col-resize ${accent === 'purple' ? 'accent-purple-500' : 'accent-cyan-500'}`}
                title={`${band.toUpperCase()} ${value} dB`}
              />
              <span className="text-[7px] font-mono uppercase text-zinc-600">{band}</span>
              <span className="text-[8px] font-mono text-zinc-400">{value.toFixed(1)}</span>
            </div>
          ))}
        </div>

        {/* Pitch */}
        <div className="flex items-center gap-2">
          <span className="text-[7px] font-mono uppercase text-zinc-600 shrink-0">Pitch</span>
          <input
            type="range" min={-8} max={8} step={0.1} value={pitch}
            onChange={(e) => onPitch(parseFloat(e.target.value))}
            className={`flex-1 h-1 cursor-col-resize ${accent === 'purple' ? 'accent-purple-500' : 'accent-cyan-500'}`}
          />
          <span className={`text-[9px] font-mono w-10 text-right ${accentText}`}>{pitch >= 0 ? '+' : ''}{pitch.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
};
