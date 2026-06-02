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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Disc, Play, Pause, ListMusic, Plus, Save, Trash2, Cast, Radio, Music2,
  ChevronUp, ChevronDown, Repeat, Magnet, Link2, Gauge,
} from 'lucide-react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { useAppUiStore } from '../state/appUiStore';
import { useSetlistStore } from '../state/setlistStore';
import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { useDjCuesStore, HOTCUE_SLOTS } from '../state/djCuesStore';
import { toCamelot, keyLabel } from '../lib/camelot';
import { WaveformPreview } from '../components/audio/WaveformPreview';
import { DjFader, DjPad, DECK_RGB } from '../components/dj/DjControls';
import {
  toggleVjPlayback, subscribeToVjPlaybackState, isVjPlaybackActive,
  type VjPlaybackState,
} from '../state/vjPlaybackBus';
import {
  sendSetToVj, sendTrackToVj, isVjSetTargetActive, type VjSetItem,
} from '../state/vjSetBus';
import * as djEngine from '../state/djEngine';

export const DJView: React.FC = () => {
  const [deckATrack, setDeckATrack] = useState<string | null>(null);
  const [deckBTrack, setDeckBTrack] = useState<string | null>(null);
  // Playing state is OWNED by the engine (real <audio> transport), mirrored
  // here via djEngine.subscribe so the disc/icon reflect actual playback.
  const [deckAPlaying, setDeckAPlaying] = useState(false);
  const [deckBPlaying, setDeckBPlaying] = useState(false);
  const [crossfader, setCrossfader] = useState(() => djEngine.getCrossfade()); // -1 A, 0 center, +1 B
  const [deckAPitch, setDeckAPitch] = useState(0);
  const [deckBPitch, setDeckBPitch] = useState(0);
  // Quantize: when on, cue jumps/sets and loop in-points snap to the beatgrid.
  const [quantize, setQuantize] = useState(false);
  // Auto-gain: level each deck toward a target loudness using analysis rms_db
  // (ReplayGain-style), so tracks mix at an even volume.
  const [autoGain, setAutoGain] = useState(true);
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
  const analyzeAll = useDjAnalysisStore((s) => s.analyzeAll);
  // Both decks' analysis (BPM + beatgrid) for SYNC / quantize at the parent,
  // where both decks are visible.
  const deckAData = useDjAnalysisStore((s) => (deckATrack ? s.byId[deckATrack]?.data ?? null : null));
  const deckBData = useDjAnalysisStore((s) => (deckBTrack ? s.byId[deckBTrack]?.data ?? null : null));
  const djTabActive = useAppUiStore((s) => s.centerTab === 'dj');
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const createSetlist = useSetlistStore((s) => s.create);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setActive = useSetlistStore((s) => s.setActive);
  const appendToSet = useSetlistStore((s) => s.append);
  const setEntries = useSetlistStore((s) => s.setEntries);
  const entryMenu = useContextMenu<{ index: number }>();

  const activeSet = activeId ? setlists[activeId] : null;

  // Setlist-entry ops driven by the right-click menu on each row.
  const moveSetEntry = (from: number, to: number) => {
    if (!activeId || !activeSet) return;
    if (to < 0 || to >= activeSet.entries.length) return;
    const arr = [...activeSet.entries];
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    setEntries(activeId, arr);
  };
  const removeSetEntry = (index: number) => {
    if (!activeId || !activeSet) return;
    setEntries(activeId, activeSet.entries.filter((_, i) => i !== index));
  };
  const sendSetEntryToVj = (index: number) => {
    if (!activeSet) return;
    const e = activeSet.entries[index];
    if (!e) return;
    const entry = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
    sendTrackToVj({
      entryId: e.entryId,
      label: e.label,
      url: entry?.audioUrl ?? e.url,
      kind: e.kind ?? 'audio',
    });
    setFlash(
      isVjSetTargetActive() ? `Sent "${e.label}" to VJ` : `Queued "${e.label}" — opens with VJ tab`,
    );
  };

  // Keep the master transport icon synced with the real VJ state.
  useEffect(() => {
    const unsub = subscribeToVjPlaybackState((s) => {
      setVjState(s);
      setVjOpen(isVjPlaybackActive());
    });
    return unsub;
  }, []);

  // Mirror the real deck transport state from the audio engine.
  useEffect(() => {
    return djEngine.subscribe((a, b) => {
      setDeckAPlaying(a.playing);
      setDeckBPlaying(b.playing);
    });
  }, []);

  // Every track should carry BPM/key/beatgrid in the DJ context. Once the DJ tab
  // is open, sweep the whole library in the background (gentle, one at a time)
  // so loops + beatgrid are ready before a track is even loaded; deck-load also
  // ensures its own. Gated on the active tab because DJView is mounted "warmed"
  // — we don't want a startup analysis storm when the user isn't in DJ.
  useEffect(() => {
    if (djTabActive && entries.length) void analyzeAll(entries.map((e) => e.id));
  }, [djTabActive, entries, analyzeAll]);

  // Load / clear a deck's audio when its selected track changes.
  useEffect(() => {
    const t = trackById(deckATrack);
    void djEngine.loadDeck('A', t ? (t.audioUrl ?? null) : null, t?.title ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckATrack]);
  useEffect(() => {
    const t = trackById(deckBTrack);
    void djEngine.loadDeck('B', t ? (t.audioUrl ?? null) : null, t?.title ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckBTrack]);

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

  // Beatmatch SYNC — match `which` deck's tempo to the other deck and align the
  // beat phase, in one press. Tempo match is octave-aware (a 70 vs 140 BPM pair
  // syncs at rate≈1, not by halving speed); pitch rides playbackRate (key-lock
  // is the next D3 step). Phase align nudges the synced deck so its beats land
  // with the other's. Needs BPM on both decks.
  const syncDeck = (which: djEngine.DeckId) => {
    const thisData = which === 'A' ? deckAData : deckBData;
    const otherData = which === 'A' ? deckBData : deckAData;
    const otherId: djEngine.DeckId = which === 'A' ? 'B' : 'A';
    const thisBpm = thisData?.bpm ?? null;
    const otherBpm = otherData?.bpm ?? null;
    if (!thisBpm || !otherBpm) return;

    // Other deck's CURRENT effective BPM (its base × its current rate).
    const otherPitch = which === 'A' ? deckBPitch : deckAPitch;
    const otherEffBpm = otherBpm * (1 + otherPitch / 100);

    // Minimal speed change that puts the tempos in an octave relationship.
    let rate = otherEffBpm / thisBpm;
    while (rate > Math.SQRT2) rate /= 2;
    while (rate < Math.SQRT1_2) rate *= 2;
    const pct = (rate - 1) * 100;
    if (which === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    djEngine.setDeckPitch(which, pct);

    // Phase align (only meaningful while the reference deck is playing).
    const thisBeats = thisData?.beats ?? null;
    const otherBeats = otherData?.beats ?? null;
    const otherStatus = djEngine.getStatus(otherId);
    const thisStatus = djEngine.getStatus(which);
    if (thisBeats && otherBeats && otherStatus.playing) {
      const interval = 60 / (thisBpm * rate);
      let delta = (beatPhase(otherStatus.currentTime, otherBeats) - beatPhase(thisStatus.currentTime, thisBeats)) * interval;
      // Smallest equivalent nudge.
      if (delta > interval / 2) delta -= interval;
      if (delta < -interval / 2) delta += interval;
      djEngine.seekDeck(which, thisStatus.currentTime + delta);
    }
    setFlash(`Synced Deck ${which} → ${otherEffBpm.toFixed(1)} BPM`);
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
          <button
            onClick={() => setQuantize((q) => !q)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
              quantize
                ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                : 'bg-black/40 text-zinc-500 border-white/10 hover:text-zinc-200 hover:border-white/25'
            }`}
            title="Quantize — snap hotcue jumps & sets to the beatgrid (beat-loops already start on a beat)"
          >
            <Magnet className="w-3 h-3" /> Quantize
          </button>
          <button
            onClick={() => setAutoGain((g) => !g)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
              autoGain
                ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                : 'bg-black/40 text-zinc-500 border-white/10 hover:text-zinc-200 hover:border-white/25'
            }`}
            title="Auto-gain — level each deck toward a target loudness (ReplayGain-style) so tracks mix evenly"
          >
            <Gauge className="w-3 h-3" /> Auto-Gain
          </button>
          {flash && (
            <span className="ml-auto text-[9px] font-mono text-cyan-300 truncate max-w-[40%]">{flash}</span>
          )}
        </div>

        <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
          <Deck
            deckId="A"
            label="DECK A"
            accent="purple"
            trackTitle={deckATitle}
            isPlaying={deckAPlaying}
            onPlay={() => djEngine.toggleDeck('A')}
            pitch={deckAPitch}
            onPitch={(v) => { setDeckAPitch(v); djEngine.setDeckPitch('A', v); }}
            eqLow={deckAEqLow}
            eqMid={deckAEqMid}
            eqHigh={deckAEqHigh}
            onEq={(b, v) => {
              if (b === 'low') setDeckAEqLow(v); else if (b === 'mid') setDeckAEqMid(v); else setDeckAEqHigh(v);
              djEngine.setDeckEq('A', b, v);
            }}
            onLoadId={setDeckATrack}
            entries={entries}
            onAddToSet={() => handleAddCurrentToSet('A')}
            onSendToVj={() => handleSendDeckToVj('A')}
            hasTrack={!!deckATrack}
            setLoaded={!!activeSet}
            entryId={deckATrack}
            audioUrl={(() => { const t = trackById(deckATrack); return t ? (t.audioUrl ?? null) : null; })()}
            onSync={() => syncDeck('A')}
            canSync={!!deckAData?.bpm && !!deckBData?.bpm}
            quantize={quantize}
            autoGain={autoGain}
          />
          <Deck
            deckId="B"
            label="DECK B"
            accent="cyan"
            trackTitle={deckBTitle}
            isPlaying={deckBPlaying}
            onPlay={() => djEngine.toggleDeck('B')}
            pitch={deckBPitch}
            onPitch={(v) => { setDeckBPitch(v); djEngine.setDeckPitch('B', v); }}
            eqLow={deckBEqLow}
            eqMid={deckBEqMid}
            eqHigh={deckBEqHigh}
            onEq={(b, v) => {
              if (b === 'low') setDeckBEqLow(v); else if (b === 'mid') setDeckBEqMid(v); else setDeckBEqHigh(v);
              djEngine.setDeckEq('B', b, v);
            }}
            onLoadId={setDeckBTrack}
            entries={entries}
            onAddToSet={() => handleAddCurrentToSet('B')}
            onSendToVj={() => handleSendDeckToVj('B')}
            hasTrack={!!deckBTrack}
            setLoaded={!!activeSet}
            entryId={deckBTrack}
            audioUrl={(() => { const t = trackById(deckBTrack); return t ? (t.audioUrl ?? null) : null; })()}
            onSync={() => syncDeck('B')}
            canSync={!!deckAData?.bpm && !!deckBData?.bpm}
            quantize={quantize}
            autoGain={autoGain}
          />
        </div>

        {/* Master crossfader */}
        <div className="shrink-0 bg-black/60 border border-white/10 rounded p-3 flex items-center gap-3 dj-surface">
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 w-8 text-right">A</span>
          <div className="flex-1">
            <DjFader
              value={crossfader}
              min={-1}
              max={1}
              defaultValue={0}
              center
              color={DECK_RGB.cyan}
              onChange={(v) => { setCrossfader(v); djEngine.setCrossfade(v); }}
              ariaLabel="Crossfader"
              title="Crossfade between Deck A and Deck B (double-click to center)"
            />
          </div>
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
                  <li
                    key={i}
                    onContextMenu={(ev) => entryMenu.open(ev, { index: i })}
                    className="px-3 py-1 border-b border-white/3 text-zinc-400 truncate cursor-context-menu hover:bg-white/5 hover:text-zinc-200"
                    title="Right-click for actions"
                  >
                    {String(i + 1).padStart(2, '0')}. {e.label}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </aside>

      {/* Right-click menu for a setlist entry. */}
      {(() => {
        const payload = entryMenu.payload;
        if (!payload || !activeSet) return null;
        const idx = payload.index;
        const e = activeSet.entries[idx];
        if (!e) return null;
        const last = activeSet.entries.length - 1;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Send to VJ',
            icon: <Cast className="w-3 h-3" />,
            onSelect: () => sendSetEntryToVj(idx),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Move up',
            icon: <ChevronUp className="w-3 h-3" />,
            disabled: idx <= 0,
            onSelect: () => moveSetEntry(idx, idx - 1),
          },
          {
            type: 'item',
            label: 'Move down',
            icon: <ChevronDown className="w-3 h-3" />,
            disabled: idx >= last,
            onSelect: () => moveSetEntry(idx, idx + 1),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Remove from setlist',
            icon: <Trash2 className="w-3 h-3" />,
            danger: true,
            onSelect: () => removeSetEntry(idx),
          },
        ];
        return (
          <ContextMenu
            position={entryMenu.position}
            onClose={entryMenu.close}
            items={items}
            title={e.label}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};

interface DeckProps {
  deckId: djEngine.DeckId;
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
  /** Library entry id of the loaded track (drives analysis). */
  entryId: string | null;
  /** Resolved audio URL of the loaded track (drives the waveform). */
  audioUrl: string | null;
  /** Beatmatch this deck to the other deck (tempo + phase). */
  onSync: () => void;
  /** Both decks have BPM, so SYNC is meaningful. */
  canSync: boolean;
  /** Global quantize — snap cues/loops to the beatgrid. */
  quantize: boolean;
  /** Global auto-gain — level the deck toward a target loudness. */
  autoGain: boolean;
}

/** Target loudness for auto-gain (rough rms_db proxy for ReplayGain). */
const AUTO_GAIN_TARGET_DB = -12;

const Deck: React.FC<DeckProps> = ({
  deckId, label, accent, trackTitle, isPlaying, onPlay, pitch, onPitch,
  eqLow, eqMid, eqHigh, onEq, onLoadId, entries, onAddToSet, onSendToVj,
  hasTrack, setLoaded, entryId, audioUrl, onSync, canSync, quantize, autoGain,
}) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const accentBorder = accent === 'purple' ? 'border-purple-500/40' : 'border-cyan-500/40';
  const accentBg = accent === 'purple' ? 'bg-purple-500/10' : 'bg-cyan-500/10';
  const deckRgb = DECK_RGB[accent];

  // Analysis (BPM / key / Camelot) for the loaded track — runs on the backend
  // on demand, cached in djAnalysisStore. Surfacing what we already compute.
  const ensureAnalyzed = useDjAnalysisStore((s) => s.ensureAnalyzed);
  const analysisEntry = useDjAnalysisStore((s) => (entryId ? s.byId[entryId] ?? null : null));
  useEffect(() => {
    if (entryId) void ensureAnalyzed(entryId);
  }, [entryId, ensureAnalyzed]);

  const a = analysisEntry?.data ?? null;
  const analyzing = analysisEntry?.status === 'running';
  const cam = a ? toCamelot(a.key, a.scale) : null;
  const bpm = a?.bpm ?? null;
  const beats = a?.beats ?? null;
  const beatLen = bpm && bpm > 0 ? 60 / bpm : null;

  // Hotcues (persisted per track) + live loop/slip state (low-frequency toggles,
  // pulled from the engine so the buttons reflect reality without per-frame work).
  const cues = useDjCuesStore((s) => (entryId ? s.byEntry[entryId] : undefined));
  const setCue = useDjCuesStore((s) => s.setCue);
  const clearCue = useDjCuesStore((s) => s.clearCue);
  const [loopActive, setLoopActiveSt] = useState(false);
  const [activeLoopBeats, setActiveLoopBeats] = useState<number | null>(null);
  const [slip, setSlipSt] = useState(false);
  const [decoding, setDecoding] = useState(false);
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    setLoopActiveSt((p) => (p === st.loopActive ? p : st.loopActive));
    setSlipSt((p) => (p === st.slip ? p : st.slip));
    setDecoding((p) => (p === st.decoding ? p : st.decoding));
  }), [deckId]);
  // Drop the "which beat-loop is lit" memory whenever the loop is disengaged.
  useEffect(() => { if (!loopActive) setActiveLoopBeats(null); }, [loopActive]);

  // Auto-gain: trim the deck toward a target loudness from analysis rms_db
  // (ReplayGain-style), or unity when off / unknown.
  const trimDb = autoGain && a?.rms_db != null
    ? Math.max(-15, Math.min(15, AUTO_GAIN_TARGET_DB - a.rms_db))
    : 0;
  useEffect(() => { djEngine.setDeckTrim(deckId, trimDb); }, [deckId, trimDb]);

  const setHotcue = (i: number) => {
    if (!entryId) return;
    const c = cues?.[i] ?? null;
    if (c == null) {
      // Set at the playhead; quantize snaps the stored cue to the nearest beat.
      const pos = djEngine.getStatus(deckId).currentTime;
      setCue(entryId, i, quantize ? nearestBeat(pos, beats) : pos);
    } else {
      // Jump; quantize lands it on the grid in case of drift.
      djEngine.seekDeck(deckId, quantize ? nearestBeat(c, beats) : c);
    }
  };
  const dropHotcue = (i: number) => { if (entryId) clearCue(entryId, i); };

  // Loops never block on analysis: until BPM is known we fall back to 120 so the
  // user can always loop; the beatgrid + beat-snapped in-point kick in the
  // moment analysis lands. effBeatLen = seconds per beat.
  const effBeatLen = beatLen ?? 0.5;
  const toggleBeatLoop = (loopBeats: number) => {
    if (!hasTrack) return;
    if (loopActive && activeLoopBeats === loopBeats) {
      djEngine.exitLoop(deckId);
      return;
    }
    const len = loopBeats * effBeatLen;
    const pos = djEngine.getStatus(deckId).currentTime;
    let inPt = pos;
    if (beats && beats.length) {
      const anchor = snapToBeat(pos, beats); // nearest beat ≤ pos
      inPt = anchor;
      // Sub-beat loops: advance to the fractional grid cell containing pos so
      // the head stays inside [in, out) and the loop actually wraps.
      if (loopBeats < 1 && len > 0) {
        inPt = anchor + Math.max(0, Math.floor((pos - anchor) / len)) * len;
      }
    }
    djEngine.setLoop(deckId, inPt, inPt + len);
    setActiveLoopBeats(loopBeats);
  };
  const rollDown = (loopBeats: number) => { if (hasTrack) djEngine.startLoopRoll(deckId, loopBeats * effBeatLen); };
  const rollUp = () => djEngine.endLoopRoll(deckId);

  // Beat-jump — move the playhead by N beats (grid-aware via beats[], else BPM).
  const beatJump = (n: number) => {
    if (!hasTrack) return;
    const pos = djEngine.getStatus(deckId).currentTime;
    let target = pos + n * effBeatLen;
    if (beats && beats.length) {
      let idx = 0;
      for (let i = 0; i < beats.length; i++) { if (beats[i] <= pos + 0.001) idx = i; else break; }
      target = beats[Math.max(0, Math.min(beats.length - 1, idx + n))];
    }
    djEngine.seekDeck(deckId, target);
  };

  return (
    <div className={`flex flex-col bg-black/40 border ${accentBorder} rounded overflow-hidden`}>
      <div className={`shrink-0 px-3 py-1.5 ${accentBg} border-b ${accentBorder} flex items-center justify-between gap-2`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <Disc className={`w-3.5 h-3.5 shrink-0 ${accentText} ${isPlaying ? 'animate-spin' : ''}`} />
          <span className={`text-[10px] font-black uppercase tracking-widest shrink-0 ${accentText}`}>{label}</span>
          <span className="text-[9px] font-mono text-zinc-400 truncate" title={hasTrack ? trackTitle : ''}>
            {hasTrack ? trackTitle : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
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
      <div className="flex-1 min-h-0 flex flex-col p-3 gap-2 dj-surface">
        {/* Transport + analysis + load — Play / Sync / BPM·KEY·Camelot, with the
            track picker filling the right of the row. */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onPlay}
            className={`p-1.5 rounded shrink-0 ${isPlaying ? 'bg-red-500/20 text-red-300 border border-red-500/40' : `${accentBg} ${accentText} border ${accentBorder}`}`}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
          </button>
          <DjPad
            color={deckRgb}
            disabled={!canSync}
            onClick={onSync}
            style={{ padding: '6px 8px', flexShrink: 0 }}
            title={canSync ? 'Beatmatch this deck to the other (tempo + phase)' : 'SYNC needs BPM on both decks'}
          >
            <Link2 className="w-3 h-3" /> Sync
          </DjPad>
          <div className="flex items-center gap-1 text-[9px] font-mono shrink-0">
            <span className="px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-zinc-300">
              <span className="text-zinc-600">BPM </span>
              {a?.bpm != null ? a.bpm.toFixed(1) : (analyzing ? '…' : '—')}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-zinc-300">
              <span className="text-zinc-600">KEY </span>
              {a?.key ? keyLabel(a.key, a.scale) : (analyzing ? '…' : '—')}
            </span>
            {cam ? (
              <span
                className="px-1.5 py-0.5 rounded font-black border"
                style={{
                  color: `hsl(${cam.hue} 80% 75%)`,
                  borderColor: `hsl(${cam.hue} 70% 45% / 0.6)`,
                  background: `hsl(${cam.hue} 70% 45% / 0.12)`,
                }}
                title={`Camelot ${cam.code} — mixes with ${cam.compatible.join(', ')}`}
              >
                {cam.code}
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded bg-black/40 border border-white/10 text-zinc-600">
                {analyzing ? '…' : '—'}
              </span>
            )}
            {decoding && (
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 animate-pulse">
                decoding…
              </span>
            )}
            {autoGain && trimDb !== 0 && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300" title="Auto-gain trim applied">
                <span className="text-emerald-600/80">GN </span>{trimDb >= 0 ? '+' : ''}{trimDb.toFixed(1)}
              </span>
            )}
          </div>
          <select
            id={`dj-deck-${deckId}-track`}
            name={`dj-deck-${deckId}-track`}
            aria-label={`${label} song selection`}
            value={entries.find((e) => e.title === trackTitle)?.id ?? ''}
            onChange={(e) => onLoadId(e.target.value || null)}
            className="flex-1 min-w-0 bg-black/40 border border-white/10 text-[10px] font-mono text-zinc-200 px-2 py-1 rounded cursor-pointer"
            title="Load a track onto this deck"
          >
            <option value="">— Load track —</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>{e.title}</option>
            ))}
          </select>
        </div>

        {/* Deck waveform — wavesurfer preview + beatgrid / playhead / loop /
            cue overlays. The playhead is driven imperatively (no per-frame
            React re-render). */}
        <div className="shrink-0">
          {audioUrl ? (
            <DeckWaveform
              deckId={deckId}
              audioUrl={audioUrl}
              beats={beats}
              cues={cues ?? null}
              accent={accent}
            />
          ) : (
            <div className="h-12 rounded bg-[#0e0c18] border border-white/5 flex items-center justify-center text-[9px] font-mono text-zinc-700">
              no track loaded
            </div>
          )}
        </div>

        {/* Hotcues — click empty to set at the playhead, click set to jump,
            right-click to clear. Persisted per track. */}
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: HOTCUE_SLOTS }, (_, i) => {
            const c = cues?.[i] ?? null;
            const set = c != null;
            return (
              <DjPad
                key={i}
                on={set}
                color={deckRgb}
                disabled={!hasTrack}
                onClick={() => setHotcue(i)}
                onContextMenu={(e) => { e.preventDefault(); dropHotcue(i); }}
                title={set ? `Cue ${i + 1} @ ${fmtTime(c)} — click to jump, right-click to clear` : `Set cue ${i + 1} at the playhead`}
              >
                {set ? `▶ ${i + 1}` : `○ ${i + 1}`}
              </DjPad>
            );
          })}
        </div>

        {/* Loop / slip — beat-synced auto-loops, momentary loop-rolls (hold),
            and a slip toggle. Disabled until BPM is known. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <Repeat className={`w-3 h-3 ${loopActive ? accentText : 'text-zinc-600'}`} />
            <span className="text-[7px] font-mono uppercase text-zinc-600 w-8">Loop</span>
            {BEAT_SIZES.map((b) => (
              <DjPad
                key={b.beats}
                className="flex-1"
                on={loopActive && activeLoopBeats === b.beats}
                color={deckRgb}
                disabled={!hasTrack}
                onClick={() => toggleBeatLoop(b.beats)}
                title={beatLen ? `${b.label}-beat loop` : `${b.label}-beat loop (~120 BPM until analyzed)`}
              >
                {b.label}
              </DjPad>
            ))}
            <DjPad
              className="flex-1"
              danger
              disabled={!loopActive}
              onClick={() => djEngine.exitLoop(deckId)}
              title="Exit loop"
            >
              Out
            </DjPad>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[7px] font-mono uppercase text-zinc-600 w-11 ml-4">Roll</span>
            {ROLL_SIZES.map((b) => (
              <DjPad
                key={b.beats}
                className="flex-1"
                disabled={!hasTrack}
                onPointerDown={(e) => { e.preventDefault(); rollDown(b.beats); }}
                onPointerUp={rollUp}
                onPointerLeave={(e) => { if (e.buttons) rollUp(); }}
                title={beatLen ? `${b.label}-beat loop-roll (hold)` : `${b.label}-beat loop-roll (~120 BPM until analyzed)`}
              >
                {b.label}
              </DjPad>
            ))}
            <DjPad
              className="flex-1"
              on={slip}
              color={[245, 158, 11]}
              disabled={!hasTrack}
              onClick={() => djEngine.setSlip(deckId, !slip)}
              title="Slip mode — on loop/roll exit, jump to where playback would be"
            >
              Slip
            </DjPad>
          </div>
        </div>

        {/* Beat-jump — nudge the playhead by whole beats (grid-aware). */}
        <div className="flex items-center gap-1">
          <span className="text-[7px] font-mono uppercase text-zinc-600 w-11 ml-4">Jump</span>
          {([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).map(([n, lbl]) => (
            <DjPad
              key={n}
              className="flex-1"
              color={deckRgb}
              disabled={!hasTrack}
              onClick={() => beatJump(n)}
              title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}
            >
              {lbl}
            </DjPad>
          ))}
        </div>

        {/* EQ — LO / MID / HI on one row (center = 0 dB, fill grows from center). */}
        <div className="grid grid-cols-3 gap-2 mt-1">
          {([['LO', eqLow, 'low'], ['MID', eqMid, 'mid'], ['HI', eqHigh, 'high']] as const).map(([label, value, band]) => (
            <div key={band} className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between">
                <span className="text-[7px] font-mono uppercase text-zinc-600">{label}</span>
                <span className="text-[8px] font-mono text-zinc-400 tabular-nums">{value >= 0 ? '+' : ''}{value.toFixed(0)}</span>
              </div>
              <DjFader
                value={value}
                min={-12}
                max={12}
                defaultValue={0}
                center
                color={deckRgb}
                onChange={(v) => onEq(band, v)}
                ariaLabel={`${label} EQ`}
                title={`${label} EQ (dB) — double-click to reset`}
              />
            </div>
          ))}
        </div>

        {/* Pitch — wide (±50%) so SYNC's tempo match is representable on the
            fader; the BPM readout shows the live effective tempo. */}
        <div className="flex items-center gap-2">
          <span className="text-[7px] font-mono uppercase text-zinc-600 shrink-0">Pitch</span>
          <div className="flex-1">
            <DjFader
              value={pitch}
              min={-50}
              max={50}
              defaultValue={0}
              center
              color={deckRgb}
              onChange={(v) => onPitch(v)}
              ariaLabel="Pitch"
              title="Tempo/pitch (coupled until key-lock) — double-click to reset"
            />
          </div>
          <span className={`text-[9px] font-mono w-10 text-right ${accentText}`}>{pitch >= 0 ? '+' : ''}{pitch.toFixed(1)}%</span>
          {bpm != null && (
            <span className="text-[9px] font-mono w-14 text-right text-zinc-300 tabular-nums" title="Effective BPM (base × pitch)">
              {(bpm * (1 + pitch / 100)).toFixed(1)}
              <span className="text-zinc-600"> BPM</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------- helpers ----------------------------------- */

/** Beat-loop sizes (in beats) offered as auto-loop buttons. */
const BEAT_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' },
  { beats: 0.5, label: '½' },
  { beats: 1, label: '1' },
  { beats: 2, label: '2' },
  { beats: 4, label: '4' },
];

/** Loop-roll sizes (momentary, hold). */
const ROLL_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' },
  { beats: 0.5, label: '½' },
  { beats: 1, label: '1' },
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Snap a time to the nearest beat at or before it (so loops start on a beat). */
function snapToBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  for (const b of beats) {
    if (b <= t) best = b;
    else break;
  }
  return best;
}

/** Snap a time to the NEAREST beat (either side) — used by quantize. */
function nearestBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  let bestD = Math.abs(t - best);
  for (const b of beats) {
    const d = Math.abs(t - b);
    if (d < bestD) { best = b; bestD = d; }
    if (b > t && d > bestD) break; // beats are sorted; we've passed the minimum
  }
  return best;
}

/** Fractional position within the current beat (0..1), from the beatgrid. */
function beatPhase(t: number, beats: number[] | null): number {
  if (!beats || beats.length < 2) return 0;
  let i = 0;
  while (i < beats.length - 1 && beats[i + 1] <= t) i++;
  const prev = beats[i];
  const next = beats[i + 1] ?? prev + (beats[i] - (beats[i - 1] ?? prev - 0.5));
  const interval = next - prev || 0.5;
  return clamp01((t - prev) / interval);
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sameLoop(a: { in: number; out: number } | null, b: { in: number; out: number } | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.in === b.in && a.out === b.out;
}

/**
 * Deck waveform with beatgrid / playhead / loop-region / hotcue overlays.
 *
 * The playhead is driven IMPERATIVELY from the engine subscription (a single
 * style.left mutation per frame) so the deck never re-renders at frame rate —
 * important on weak machines. Only low-frequency changes (duration, loop region)
 * use React state. A transparent click-catcher sits above the wavesurfer canvas
 * so seeks route to our engine (not wavesurfer's own cursor).
 */
const DeckWaveform: React.FC<{
  deckId: djEngine.DeckId;
  audioUrl: string;
  beats: number[] | null;
  cues: (number | null)[] | null;
  accent: 'purple' | 'cyan';
}> = ({ deckId, audioUrl, beats, cues, accent }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const [loop, setLoop] = useState<{ in: number; out: number } | null>(null);

  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    const d = st.duration || 0;
    setDur((p) => (p === d ? p : d));
    if (playheadRef.current) {
      playheadRef.current.style.left = d > 0 ? `${(st.currentTime / d) * 100}%` : '0%';
    }
    const nl = st.loopActive && st.loopIn != null && st.loopOut != null
      ? { in: st.loopIn, out: st.loopOut }
      : null;
    setLoop((p) => (sameLoop(p, nl) ? p : nl));
  }), [deckId]);

  // Beatgrid marks (memoized). Thin to downbeats only when very dense so weak
  // machines don't paint hundreds of lines.
  const beatMarks = useMemo(() => {
    if (!beats || beats.length === 0 || dur <= 0) return null;
    const dense = beats.length <= 400;
    const out: Array<{ left: number; down: boolean }> = [];
    for (let i = 0; i < beats.length; i++) {
      const down = i % 4 === 0;
      if (!dense && !down) continue;
      out.push({ left: (beats[i] / dur) * 100, down });
    }
    return out;
  }, [beats, dur]);

  const accentColor = accent === 'purple' ? '#a855f7' : '#22d3ee';

  // Drag-scrubbing — pull the playhead through the track to find a spot instead
  // of playing from the start and waiting. Seeks are rAF-throttled so a fast
  // drag doesn't restart the buffer source dozens of times per frame; pointer
  // capture keeps the drag tracking even when it leaves the lane.
  const scrubbing = useRef(false);
  const pendingX = useRef<number | null>(null);
  const scrubRaf = useRef(0);
  const applyScrub = () => {
    scrubRaf.current = 0;
    const x = pendingX.current;
    pendingX.current = null;
    const el = containerRef.current;
    if (x == null || !el || dur <= 0) return;
    const rect = el.getBoundingClientRect();
    djEngine.seekDeck(deckId, clamp01((x - rect.left) / rect.width) * dur);
  };
  const queueScrub = (clientX: number) => {
    pendingX.current = clientX;
    if (!scrubRaf.current) scrubRaf.current = requestAnimationFrame(applyScrub);
  };
  const onScrubDown = (e: React.PointerEvent) => {
    if (dur <= 0) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    queueScrub(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent) => { if (scrubbing.current) queueScrub(e.clientX); };
  const onScrubUp = (e: React.PointerEvent) => {
    scrubbing.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  useEffect(() => () => { if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current); }, []);

  return (
    <div ref={containerRef} className="relative">
      <WaveformPreview audioUrl={audioUrl} height={48} />

      {/* Scrub catcher — above the canvas so seeks drive our engine, not
          wavesurfer's own cursor. Drag to scrub, click to jump. */}
      <div
        className="absolute inset-0 cursor-ew-resize"
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
        title="Drag to scrub · click to seek"
      />

      {/* Beatgrid */}
      {beatMarks && (
        <div className="absolute inset-0 pointer-events-none">
          {beatMarks.map((m, i) => (
            <div
              key={i}
              className="absolute top-0 bottom-0"
              style={{ left: `${m.left}%`, width: '1px', background: m.down ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)' }}
            />
          ))}
        </div>
      )}

      {/* Loop region */}
      {loop && dur > 0 && (
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: `${(loop.in / dur) * 100}%`,
            width: `${((loop.out - loop.in) / dur) * 100}%`,
            background: 'rgba(245,200,66,0.18)',
            borderLeft: '1px solid rgba(245,200,66,0.7)',
            borderRight: '1px solid rgba(245,200,66,0.7)',
          }}
        />
      )}

      {/* Hotcue markers */}
      {dur > 0 && cues && cues.map((c, i) => (c == null ? null : (
        <div
          key={i}
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ left: `${(c / dur) * 100}%`, width: '2px', background: accentColor }}
        >
          <span className="absolute top-0 left-0 text-[6px] font-black text-black px-0.5 leading-tight" style={{ background: accentColor }}>
            {i + 1}
          </span>
        </div>
      )))}

      {/* Playhead (imperative) */}
      <div
        ref={playheadRef}
        className="absolute top-0 bottom-0 pointer-events-none"
        style={{ left: '0%', width: '2px', background: '#ffffff', boxShadow: '0 0 4px rgba(255,255,255,0.8)' }}
      />
    </div>
  );
};

