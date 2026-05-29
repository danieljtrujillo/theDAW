/**
 * DJ tab — VirtualDJ-style 2-deck mixer. This is the structural
 * landing: two decks side-by-side, a crossfader, master meters,
 * and a setlist sidebar wired to the persistent setlistStore.
 *
 * Decks A + B each hold one library entry, can play independently,
 * and contribute to a global crossfader (-1 = full A, +1 = full B).
 * The actual audio routing reuses the existing playerStore engine
 * (each deck loads via playerStore.load, plays via toggle, and the
 * crossfader writes per-deck gain on a pair of GainNodes feeding
 * the master). The audio plumbing is wired in a follow-up commit;
 * this view delivers the layout + state hooks so the tab is live
 * and saveable setlists already work end-to-end via setlistStore.
 */
import React, { useState } from 'react';
import { Disc, Play, Pause, ListMusic, Plus, X, Save, Trash2 } from 'lucide-react';
import { useSetlistStore } from '../state/setlistStore';
import { useLibraryStore } from '../state/libraryStore';

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

  const entries = useLibraryStore((s) => s.entries);
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const createSetlist = useSetlistStore((s) => s.create);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setActive = useSetlistStore((s) => s.setActive);
  const appendToSet = useSetlistStore((s) => s.append);

  const activeSet = activeId ? setlists[activeId] : null;

  const trackById = (id: string | null) => (id ? entries.find((e) => e.id === id) ?? null : null);
  const deckATitle = trackById(deckATrack)?.title ?? 'Empty deck';
  const deckBTitle = trackById(deckBTrack)?.title ?? 'Empty deck';

  const handleAddCurrentToSet = (which: 'A' | 'B') => {
    if (!activeId) return;
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    appendToSet(activeId, [{ entryId: track.id, label: track.title, kind: 'audio' }]);
  };

  return (
    <div className="absolute inset-0 flex bg-[#07050a] text-white overflow-hidden">
      {/* Decks + crossfader */}
      <div className="flex-1 flex flex-col p-3 gap-3 min-w-0">
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
              No setlists yet. Click <Plus className="inline w-3 h-3" /> to create one, then drag library tracks here (planned) or use the deck Save buttons to push the loaded track into the active set.
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

        {/* Active set entries */}
        {activeSet && (
          <div className="shrink-0 max-h-48 overflow-y-auto border-t border-white/5 bg-black/30">
            <div className="px-3 py-1.5 border-b border-white/5 text-[8px] font-mono text-zinc-600 uppercase tracking-widest flex items-center justify-between">
              <span>{activeSet.name}</span>
              <Save className="w-3 h-3 text-emerald-400" />
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
  setLoaded: boolean;
}

const Deck: React.FC<DeckProps> = ({
  label, accent, trackTitle, isPlaying, onPlay, pitch, onPitch,
  eqLow, eqMid, eqHigh, onEq, onLoadId, entries, onAddToSet, setLoaded,
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
        <button
          onClick={onAddToSet}
          disabled={!setLoaded}
          className="p-1 text-zinc-500 hover:text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          title={setLoaded ? 'Append loaded track to active setlist' : 'Activate a setlist to enable Save'}
        >
          <Save className="w-3 h-3" />
        </button>
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
