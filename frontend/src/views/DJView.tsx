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
  Disc, Play, Pause, ListMusic, Plus, Save, Trash2, Cast, Music2,
  ChevronUp, ChevronDown, ChevronRight, Repeat, Magnet, Link2, Gauge, Lock, KeyRound, Pencil, Check,
} from 'lucide-react';
import { useAppUiStore } from '../state/appUiStore';
import { useSetlistStore, type Setlist, type SetlistEntry } from '../state/setlistStore';
import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { useDjCuesStore, HOTCUE_SLOTS } from '../state/djCuesStore';
import { toCamelot, keyLabel } from '../lib/camelot';
import { buildBeatgrid } from '../lib/beatgrid';
import { WaveformPreview } from '../components/audio/WaveformPreview';
import { DjFader, DjPad, DECK_RGB } from '../components/dj/DjControls';
import {
  sendSetToVj, sendTrackToVj, isVjSetTargetActive, type VjSetItem,
} from '../state/vjSetBus';
import { registerDjMasterHandler, reportDjMasterState } from '../state/djMasterBus';
import * as djEngine from '../state/djEngine';

/** DnD payload type for dragging a set/library track onto a deck. */
const DJ_TRACK_MIME = 'application/x-thedaw-djtrack';

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
  // Sync-Lock — at most one deck is the FOLLOWER, continuously matched (tempo +
  // phase) to the other. null = no lock. Grabbing the follower's pitch releases it.
  const [syncLock, setSyncLock] = useState<djEngine.DeckId | null>(null);
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

  const [flash, setFlash] = useState<string | null>(null);

  const entries = useLibraryStore((s) => s.entries);
  const analyzeAll = useDjAnalysisStore((s) => s.analyzeAll);
  // Both decks' analysis (BPM + beatgrid) for SYNC / quantize at the parent,
  // where both decks are visible.
  const deckAData = useDjAnalysisStore((s) => (deckATrack ? s.byId[deckATrack]?.data ?? null : null));
  const deckBData = useDjAnalysisStore((s) => (deckBTrack ? s.byId[deckBTrack]?.data ?? null : null));
  // Harmonic-mix indicator — do the two loaded keys mix on the Camelot wheel?
  const camA = deckAData ? toCamelot(deckAData.key, deckAData.scale) : null;
  const camB = deckBData ? toCamelot(deckBData.key, deckBData.scale) : null;
  const harmonic = camA && camB ? camA.compatible.includes(camB.code) : null;
  const djTabActive = useAppUiStore((s) => s.centerTab === 'dj');
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const appendToSet = useSetlistStore((s) => s.append);

  const activeSet = activeId ? setlists[activeId] : null;

  // Refs so the (stably-registered) footer master handler always sees fresh
  // deck/set state without re-registering on every render.
  const deckATrackRef = useRef<string | null>(deckATrack);
  const deckBTrackRef = useRef<string | null>(deckBTrack);
  deckATrackRef.current = deckATrack;
  deckBTrackRef.current = deckBTrack;
  const pendingPlayRef = useRef<djEngine.DeckId | null>(null);
  const masterPlayingRef = useRef(false);

  // Mirror the real deck transport state from the audio engine, fulfil a pending
  // master-play once a freshly-loaded deck has decoded, and report the master
  // (decks) play state to the footer so its ▶ icon stays honest.
  useEffect(() => {
    return djEngine.subscribe((a, b) => {
      setDeckAPlaying(a.playing);
      setDeckBPlaying(b.playing);
      const pend = pendingPlayRef.current;
      if (pend) {
        const st = pend === 'A' ? a : b;
        if (st.hasBuffer && !st.decoding && !st.playing) {
          djEngine.playDeck(pend);
          pendingPlayRef.current = null;
        }
      }
      const playing = a.playing || b.playing;
      if (playing !== masterPlayingRef.current) {
        masterPlayingRef.current = playing;
        reportDjMasterState(playing ? 'playing' : 'paused');
      }
    });
  }, []);

  // Footer "Live Master" ▶ drives the DJ decks / the active set (not the global
  // single-track player). Registered once; reads fresh state via refs/getState.
  useEffect(() => {
    const startSet = () => {
      const aHas = !!deckATrackRef.current;
      const bHas = !!deckBTrackRef.current;
      if (aHas || bHas) {
        if (aHas) djEngine.playDeck('A');
        if (bHas) djEngine.playDeck('B');
        return;
      }
      // Empty decks → load the active set's first track onto A and play from the
      // top once it decodes (auto-cue lands it on the first beat).
      const sl = useSetlistStore.getState();
      const set = sl.activeId ? sl.setlists[sl.activeId] : null;
      const first = set?.entries.find((e) => e.entryId) ?? null;
      if (first?.entryId) {
        pendingPlayRef.current = 'A';
        setDeckATrack(first.entryId);
      }
    };
    return registerDjMasterHandler({
      toggle: () => {
        const aPlaying = djEngine.getStatus('A').playing;
        const bPlaying = djEngine.getStatus('B').playing;
        if (aPlaying || bPlaying) {
          if (aPlaying) djEngine.pauseDeck('A');
          if (bPlaying) djEngine.pauseDeck('B');
          reportDjMasterState('paused');
        } else {
          startSet();
          reportDjMasterState('playing');
        }
      },
      getState: () =>
        djEngine.getStatus('A').playing || djEngine.getStatus('B').playing ? 'playing' : 'paused',
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

    // Phase align (only meaningful while the reference deck is playing). Uses the
    // RAW detected beats (real onsets) so the match is to what you actually hear —
    // a constant grid can drift from the audio when the analyzed BPM is a hair off.
    const thisBeats = (which === 'A' ? deckAData : deckBData)?.beats ?? null;
    const otherBeats = (which === 'A' ? deckBData : deckAData)?.beats ?? null;
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

  // Sync-Lock: engage = instant one-shot sync, then a continuous follower. Click
  // again (or grab the follower's pitch fader) to release. Mutually exclusive —
  // only one deck follows at a time.
  const toggleSyncLock = (which: djEngine.DeckId) => {
    if (syncLock === which) { setSyncLock(null); return; }
    syncDeck(which);
    setSyncLock(which);
    setFlash(`Sync-Lock: Deck ${which} follows Deck ${which === 'A' ? 'B' : 'A'}`);
  };

  // Continuous Sync-Lock PLL — keep the follower matched to the master in tempo
  // (octave-aware) and phase. Phase is corrected by gentle rate-bending, NOT
  // seeks: setDeckPitch is click-free, while seekDeck restarts the source. A
  // deadband lets it settle instead of hunting. ~350ms handles slow drift and
  // stays cheap on a weak machine.
  useEffect(() => {
    if (!syncLock) return;
    const follower = syncLock;
    const master: djEngine.DeckId = follower === 'A' ? 'B' : 'A';
    const fBpm = (follower === 'A' ? deckAData : deckBData)?.bpm ?? null;
    const mBpm = (follower === 'A' ? deckBData : deckAData)?.bpm ?? null;
    const fBeats = (follower === 'A' ? deckAData : deckBData)?.beats ?? null;
    const mBeats = (follower === 'A' ? deckBData : deckAData)?.beats ?? null;
    if (!fBpm || !mBpm || !fBeats || !mBeats) return;

    const KP = 12;         // phase error (beats) → corrective % rate bend
    const MAX_BEND = 4;    // cap the corrective bend (%)
    const DEADBAND = 0.02; // beats; inside this, just hold the matched tempo

    const id = window.setInterval(() => {
      const fs = djEngine.getStatus(follower);
      const ms = djEngine.getStatus(master);
      if (!fs.playing || !ms.playing) return; // only correct while both run
      // Tempo: octave-aware match to the master's CURRENT effective BPM.
      const mEff = mBpm * (1 + ms.pitchPct / 100);
      let rate = mEff / fBpm;
      while (rate > Math.SQRT2) rate /= 2;
      while (rate < Math.SQRT1_2) rate *= 2;
      // Phase: where each deck sits within its beat (0..1); wrap the error to ±½.
      let dPhase = beatPhase(ms.currentTime, mBeats) - beatPhase(fs.currentTime, fBeats);
      if (dPhase > 0.5) dPhase -= 1;
      if (dPhase < -0.5) dPhase += 1;
      const bend = Math.abs(dPhase) > DEADBAND
        ? Math.max(-MAX_BEND, Math.min(MAX_BEND, dPhase * KP))
        : 0;
      const pct = Math.max(-50, Math.min(50, (rate - 1) * 100 + bend));
      djEngine.setDeckPitch(follower, pct);
      if (follower === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    }, 350);
    return () => window.clearInterval(id);
  }, [syncLock, deckAData, deckBData]);

  return (
    <div className="absolute inset-0 flex flex-col bg-[#07050a] text-white overflow-hidden">
      {/* Decks — top, expanded (the old master IDLE bar is gone; the footer ▶ is
          the master, and the mix toggles now live under the crossfader). */}
      <div className="flex-1 grid grid-cols-2 gap-3 min-h-0 p-3 pb-1">
          <Deck
            deckId="A"
            label="DECK A"
            accent="purple"
            trackTitle={deckATitle}
            isPlaying={deckAPlaying}
            onPlay={() => djEngine.toggleDeck('A')}
            pitch={deckAPitch}
            onPitch={(v) => { if (syncLock === 'A') setSyncLock(null); setDeckAPitch(v); djEngine.setDeckPitch('A', v); }}
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
            onSyncLock={() => toggleSyncLock('A')}
            syncLocked={syncLock === 'A'}
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
            onPitch={(v) => { if (syncLock === 'B') setSyncLock(null); setDeckBPitch(v); djEngine.setDeckPitch('B', v); }}
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
            onSyncLock={() => toggleSyncLock('B')}
            syncLocked={syncLock === 'B'}
            canSync={!!deckAData?.bpm && !!deckBData?.bpm}
            quantize={quantize}
            autoGain={autoGain}
          />
        </div>

        {/* Crossfader + mix toggles, centered below the decks. */}
        <div className="shrink-0 px-3 pt-1.5 pb-1 dj-surface">
          <div className="flex items-center gap-3 max-w-2xl mx-auto">
            <span className="text-[11px] font-black uppercase tracking-widest text-purple-300 w-6 text-right">A</span>
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
            <span className="text-[11px] font-black uppercase tracking-widest text-cyan-300 w-6 text-left">B</span>
          </div>
          {/* Mix toggles: crossfade readout + quantize / auto-gain / harmonic
              (moved down from the removed master bar). */}
          <div className="flex items-center justify-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] font-mono text-zinc-600 tabular-nums w-16 text-center">
              {crossfader < -0.05 ? `A ${Math.round((1 + crossfader) * 100)}%` : crossfader > 0.05 ? `B ${Math.round((1 - crossfader) * -100 + 100)}%` : 'CENTER'}
            </span>
            <button
              onClick={() => setQuantize((q) => !q)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
                quantize ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40' : 'bg-black/40 text-zinc-500 border-white/10 hover:text-zinc-200 hover:border-white/25'
              }`}
              title="Quantize — snap hotcue jumps & sets to the beatgrid"
            >
              <Magnet className="w-3 h-3" /> Quantize
            </button>
            <button
              onClick={() => setAutoGain((g) => !g)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
                autoGain ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40' : 'bg-black/40 text-zinc-500 border-white/10 hover:text-zinc-200 hover:border-white/25'
              }`}
              title="Auto-gain — level each deck toward a target loudness"
            >
              <Gauge className="w-3 h-3" /> Auto-Gain
            </button>
            {camA && camB && (
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border ${
                  harmonic ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                }`}
                title={harmonic ? `Harmonic match — ${camA.code} ↔ ${camB.code} mix in key` : `Key clash — ${camA.code} vs ${camB.code} aren't adjacent on the Camelot wheel`}
              >
                <Music2 className="w-3 h-3" />
                {harmonic ? 'In Key' : 'Clash'}
                <span className="font-mono normal-case tracking-normal text-zinc-400">{camA.code}·{camB.code}</span>
              </div>
            )}
            {flash && <span className="text-[9px] font-mono text-cyan-300 truncate max-w-xs">{flash}</span>}
          </div>
        </div>

      {/* Setlist — collapsible panel centered under the crossfader. */}
      <SetlistPanel />
    </div>
  );
};

/**
 * Setlist panel — collapsible, centered under the crossfader. Lists every set;
 * click to activate, double-click / pencil to rename, ▸/▾ to expand a set's
 * tracks. Inside a set: reorder (▲/▼), send-to-VJ, remove, and each track is
 * draggable straight onto a deck to load it.
 */
const SetlistPanel: React.FC = () => {
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const createSetlist = useSetlistStore((s) => s.create);
  const renameSetlist = useSetlistStore((s) => s.rename);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setActive = useSetlistStore((s) => s.setActive);
  const setEntries = useSetlistStore((s) => s.setEntries);
  const entries = useLibraryStore((s) => s.entries);

  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(activeId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const sets = Object.values(setlists).sort((a, b) => b.updatedAt - a.updatedAt);

  const startRename = (id: string, name: string) => { setEditingId(id); setEditName(name); };
  const commitRename = () => {
    if (editingId && editName.trim()) renameSetlist(editingId, editName.trim());
    setEditingId(null);
  };
  const reorder = (setId: string, from: number, to: number) => {
    const set = setlists[setId];
    if (!set || to < 0 || to >= set.entries.length) return;
    const arr = [...set.entries];
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    setEntries(setId, arr);
  };
  const removeEntry = (setId: string, index: number) => {
    const set = setlists[setId];
    if (set) setEntries(setId, set.entries.filter((_, i) => i !== index));
  };
  const sendEntry = (e: SetlistEntry) => {
    const entry = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
    sendTrackToVj({ entryId: e.entryId, label: e.label, url: entry?.audioUrl ?? e.url, kind: e.kind ?? 'audio' });
  };
  const sendWholeSet = (set: Setlist) => {
    const items: VjSetItem[] = set.entries.map((e) => {
      const entry = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
      return { entryId: e.entryId, label: e.label, url: entry?.audioUrl ?? e.url, kind: e.kind ?? 'audio' };
    });
    sendSetToVj({ setId: set.id, name: set.name, items });
  };

  return (
    <div className="shrink-0 w-full max-w-2xl mx-auto border-x border-t border-white/10 bg-[#0a080f]">
      {/* Header (always visible) — collapse toggle + new-set. */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-purple-500/4">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 text-purple-200 hover:text-purple-100 transition-colors"
          title={collapsed ? 'Expand setlists' : 'Collapse setlists'}
        >
          {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <ListMusic className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-[10px] font-black uppercase tracking-widest">Setlists</span>
          <span className="text-[9px] font-mono text-zinc-600">({sets.length})</span>
        </button>
        <button
          onClick={() => { const id = createSetlist(`Set ${new Date().toLocaleDateString()}`); setActive(id); setExpandedId(id); }}
          className="p-1 rounded text-purple-300 hover:bg-purple-500/15 hover:text-purple-100 transition-colors"
          title="New setlist"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="max-h-56 overflow-y-auto">
            {sets.length === 0 ? (
              <div className="p-3 text-[9px] font-mono text-zinc-600 leading-relaxed text-center">
                No setlists yet. Click + to create one, then a deck's Save button adds the loaded track.
              </div>
            ) : sets.map((s) => {
              const isActive = s.id === activeId;
              const isOpen = expandedId === s.id;
              return (
                <div key={s.id} className={`border-b border-white/5 ${isActive ? 'bg-purple-500/8' : ''}`}>
                  {/* Set row */}
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <button
                      onClick={() => setExpandedId(isOpen ? null : s.id)}
                      className="p-0.5 text-zinc-500 hover:text-zinc-200 shrink-0"
                      title={isOpen ? 'Collapse tracks' : 'Expand tracks'}
                    >
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    {editingId === s.id ? (
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                        onBlur={commitRename}
                        className="flex-1 min-w-0 bg-black/50 border border-purple-400/50 rounded px-1.5 py-0.5 text-[10px] text-zinc-100 focus:outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => setActive(s.id)}
                        onDoubleClick={() => startRename(s.id, s.name)}
                        className={`flex-1 min-w-0 text-left text-[10px] font-bold truncate ${isActive ? 'text-purple-200' : 'text-zinc-300 hover:text-zinc-100'}`}
                        title="Click to activate · double-click to rename"
                      >
                        {s.name}
                      </button>
                    )}
                    <span className="text-[8px] font-mono text-zinc-600 shrink-0 px-1">{s.entries.length}</span>
                    {editingId === s.id ? (
                      <button onClick={commitRename} className="p-0.5 text-emerald-400 hover:text-emerald-300 shrink-0" title="Save name"><Check className="w-3 h-3" /></button>
                    ) : (
                      <button onClick={() => startRename(s.id, s.name)} className="p-0.5 text-zinc-600 hover:text-zinc-300 shrink-0" title="Rename"><Pencil className="w-3 h-3" /></button>
                    )}
                    <button onClick={() => sendWholeSet(s)} disabled={s.entries.length === 0} className="p-0.5 text-zinc-600 hover:text-cyan-300 disabled:opacity-30 shrink-0" title="Send SET to VJ"><Cast className="w-3 h-3" /></button>
                    <button onClick={() => removeSetlist(s.id)} className="p-0.5 text-zinc-600 hover:text-rose-400 shrink-0" title="Delete setlist"><Trash2 className="w-3 h-3" /></button>
                  </div>

                  {/* Tracks (expanded) */}
                  {isOpen && (
                    s.entries.length === 0 ? (
                      <div className="px-3 pb-2 pl-8 text-[9px] text-zinc-700 italic">Empty — load a deck and hit Save, or drag a track here.</div>
                    ) : (
                      <ol className="pb-1">
                        {s.entries.map((e, i) => (
                          <li
                            key={i}
                            draggable={!!e.entryId}
                            onDragStart={(ev) => {
                              if (!e.entryId) return;
                              ev.dataTransfer.effectAllowed = 'copy';
                              ev.dataTransfer.setData(DJ_TRACK_MIME, e.entryId);
                              ev.dataTransfer.setData('text/plain', e.label);
                            }}
                            className="flex items-center gap-1 pl-8 pr-2 py-0.5 text-[9px] font-mono text-zinc-400 hover:bg-white/5 group/track cursor-grab active:cursor-grabbing"
                            title="Drag onto a deck to load"
                          >
                            <span className="text-zinc-600 w-5 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                            <span className="flex-1 truncate">{e.label}</span>
                            <span className="hidden group-hover/track:flex items-center gap-0.5 shrink-0">
                              <button onClick={() => reorder(s.id, i, i - 1)} disabled={i === 0} className="p-0.5 text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move up"><ChevronUp className="w-3 h-3" /></button>
                              <button onClick={() => reorder(s.id, i, i + 1)} disabled={i === s.entries.length - 1} className="p-0.5 text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move down"><ChevronDown className="w-3 h-3" /></button>
                              <button onClick={() => sendEntry(e)} className="p-0.5 text-zinc-600 hover:text-cyan-300" title="Send to VJ"><Cast className="w-3 h-3" /></button>
                              <button onClick={() => removeEntry(s.id, i)} className="p-0.5 text-zinc-600 hover:text-rose-400" title="Remove from set"><Trash2 className="w-3 h-3" /></button>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )
                  )}
                </div>
              );
            })}
          </div>
          <div className="px-3 py-1 text-center text-[8px] font-mono text-zinc-600 border-t border-white/5">
            {isVjSetTargetActive() ? 'VJ linked — sets deliver instantly' : 'VJ closed — sets deliver when it opens'} · drag a track onto a deck to load
          </div>
        </>
      )}
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
  /** Toggle continuous Sync-Lock — this deck follows the other. */
  onSyncLock: () => void;
  /** This deck is the active Sync-Lock follower. */
  syncLocked: boolean;
  /** Both decks have BPM, so SYNC / Sync-Lock are meaningful. */
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
  hasTrack, setLoaded, entryId, audioUrl, onSync, onSyncLock, syncLocked,
  canSync, quantize, autoGain,
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
  // Constant beatgrid (drift-proof): a uniform grid at the analyzed tempo,
  // anchored to the first detected beat. Everything beat-aware on the deck —
  // marks, loop in-points, quantize, beat-jump — rides this instead of the raw
  // (sometimes jittery) beat list.
  const grid = useMemo(
    () => buildBeatgrid({ bpm, beats, duration: a?.duration_sec }),
    [bpm, beats, a?.duration_sec],
  );
  const gridBeats = grid?.beats ?? beats;
  const firstBeat = beats && beats.length > 0 ? beats[0] : null;

  // Hotcues (persisted per track) + live loop/slip state (low-frequency toggles,
  // pulled from the engine so the buttons reflect reality without per-frame work).
  const cues = useDjCuesStore((s) => (entryId ? s.byEntry[entryId] : undefined));
  const setCue = useDjCuesStore((s) => s.setCue);
  const clearCue = useDjCuesStore((s) => s.clearCue);
  const [loopActive, setLoopActiveSt] = useState(false);
  const [activeLoopBeats, setActiveLoopBeats] = useState<number | null>(null);
  const [slip, setSlipSt] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [keylock, setKeylockSt] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    setLoopActiveSt((p) => (p === st.loopActive ? p : st.loopActive));
    setSlipSt((p) => (p === st.slip ? p : st.slip));
    setDecoding((p) => (p === st.decoding ? p : st.decoding));
    setKeylockSt((p) => (p === st.keylock ? p : st.keylock));
  }), [deckId]);
  // Drop the "which beat-loop is lit" memory whenever the loop is disengaged.
  useEffect(() => { if (!loopActive) setActiveLoopBeats(null); }, [loopActive]);

  // Auto-cue to the first beat: once a fresh track has both decoded (buffer
  // ready) and analyzed (first beat known), if the deck is still untouched at
  // the very start, seek to that first beat so play begins on the downbeat
  // instead of through lead-in silence. `decoding` in the deps re-runs this when
  // the buffer finishes, so it works regardless of analyze-vs-decode order.
  const autoCuedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!entryId || autoCuedRef.current === entryId) return;
    if (firstBeat == null || firstBeat <= 0.05) return; // wait for analysis
    const st = djEngine.getStatus(deckId);
    if (st.duration <= 0) return; // buffer not decoded yet — retry when it is
    if (!st.playing && st.currentTime <= 0.05) djEngine.seekDeck(deckId, firstBeat);
    autoCuedRef.current = entryId; // only mark done after a real attempt
  }, [entryId, firstBeat, deckId, decoding]);

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
      setCue(entryId, i, quantize ? nearestBeat(pos, gridBeats) : pos);
    } else {
      // Jump; quantize lands it on the grid in case of drift.
      djEngine.seekDeck(deckId, quantize ? nearestBeat(c, gridBeats) : c);
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
    if (gridBeats && gridBeats.length) {
      const anchor = snapToBeat(pos, gridBeats); // nearest grid line ≤ pos
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
    if (gridBeats && gridBeats.length) {
      let idx = 0;
      for (let i = 0; i < gridBeats.length; i++) { if (gridBeats[i] <= pos + 0.001) idx = i; else break; }
      target = gridBeats[Math.max(0, Math.min(gridBeats.length - 1, idx + n))];
    }
    djEngine.seekDeck(deckId, target);
  };

  return (
    <div
      className={`flex flex-col bg-black/40 border ${accentBorder} rounded overflow-hidden transition-shadow ${dropHover ? 'ring-2 ring-inset ring-white/50' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DJ_TRACK_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropHover(true); }
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        setDropHover(false);
        const id = e.dataTransfer.getData(DJ_TRACK_MIME);
        if (id) { e.preventDefault(); onLoadId(id); }
      }}
    >
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
          <DjPad
            color={deckRgb}
            on={syncLocked}
            disabled={!canSync}
            onClick={onSyncLock}
            style={{ padding: '6px 8px', flexShrink: 0 }}
            title={canSync ? 'Sync-Lock — continuously hold tempo + phase to the other deck (grab the pitch fader to release)' : 'Sync-Lock needs BPM on both decks'}
          >
            <Lock className="w-3 h-3" /> Lock
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
            className={`flex-1 min-w-0 bg-[#0e0c18] border ${accentBorder} ${accentText} text-[10px] font-mono px-2 py-1 rounded cursor-pointer focus:outline-none hover:bg-[#161320] transition-colors`}
            style={{ colorScheme: 'dark' }}
            title="Load a track onto this deck (or drag one from a setlist)"
          >
            <option value="" className="bg-[#0e0c18] text-zinc-400">— Load track —</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id} className="bg-[#0e0c18] text-zinc-200">{e.title}</option>
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
              beats={gridBeats}
              cues={cues ?? null}
              accent={accent}
            />
          ) : (
            <div className="h-12 rounded bg-[#0e0c18] border border-white/5 flex items-center justify-center text-[11px] font-mono text-zinc-700">
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
            <span className="text-[9px] font-mono uppercase text-zinc-600 w-8">Loop</span>
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
            <span className="text-[9px] font-mono uppercase text-zinc-600 w-11 ml-4">Roll</span>
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
          <span className="text-[9px] font-mono uppercase text-zinc-600 w-11 ml-4">Jump</span>
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
                <span className="text-[9px] font-mono uppercase text-zinc-600">{label}</span>
                <span className="text-[10px] font-mono text-zinc-400 tabular-nums">{value >= 0 ? '+' : ''}{value.toFixed(0)}</span>
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

        {/* Pitch — equal-width gutters keep the fader centered; the effective
            BPM sits below so the readouts can't push it off-center. ±50% so
            SYNC's tempo match is representable. */}
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-mono uppercase text-zinc-600 w-12 text-right shrink-0">Pitch</span>
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
            <span className={`text-[11px] font-mono w-12 text-left tabular-nums shrink-0 ${accentText}`}>{pitch >= 0 ? '+' : ''}{pitch.toFixed(1)}%</span>
          </div>
          {/* Key-lock (master tempo) toggle + effective-BPM readout. Sits below
              the fader so it can't pull the centered pitch fader off-center. */}
          <div className="flex items-center justify-center gap-2 mt-0.5">
            <DjPad
              on={keylock}
              color={deckRgb}
              disabled={!hasTrack}
              onClick={() => void djEngine.setDeckKeylock(deckId, !keylock)}
              style={{ padding: '2px 6px', flexShrink: 0 }}
              title="Key-lock / Master Tempo — change tempo (pitch fader, SYNC, Sync-Lock) without changing the musical key"
            >
              <KeyRound className="w-3 h-3" /> Key
            </DjPad>
            {bpm != null && (
              <span className="text-[10px] font-mono text-zinc-300 tabular-nums" title="Effective BPM (base × tempo)">
                {(bpm * (1 + pitch / 100)).toFixed(1)}<span className="text-zinc-600"> BPM</span>
              </span>
            )}
          </div>
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
  // Duration is read LIVE from the engine (not the React `dur` state) so a click
  // seeks even before a status tick has updated local state.
  const seekToClientX = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const d = djEngine.getStatus(deckId).duration;
    if (d <= 0) return;
    const rect = el.getBoundingClientRect();
    djEngine.seekDeck(deckId, clamp01((clientX - rect.left) / rect.width) * d);
  };
  const applyScrub = () => {
    scrubRaf.current = 0;
    const x = pendingX.current;
    pendingX.current = null;
    if (x != null) seekToClientX(x);
  };
  const queueScrub = (clientX: number) => {
    pendingX.current = clientX;
    if (!scrubRaf.current) scrubRaf.current = requestAnimationFrame(applyScrub);
  };
  const onScrubDown = (e: React.PointerEvent) => {
    if (djEngine.getStatus(deckId).duration <= 0) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekToClientX(e.clientX); // jump immediately on press, not just on the rAF tick
  };
  const onScrubMove = (e: React.PointerEvent) => { if (scrubbing.current) queueScrub(e.clientX); };
  const onScrubUp = (e: React.PointerEvent) => {
    scrubbing.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  useEffect(() => () => { if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current); }, []);

  return (
    <div ref={containerRef} className="relative">
      <WaveformPreview audioUrl={audioUrl} height={48} interact={false} />

      {/* Scrub catcher — above the canvas (z-10) so seeks drive our engine, not
          wavesurfer's own cursor. Drag to scrub, click to jump. touch-none keeps
          a touch-drag from scrolling the panel instead of scrubbing. */}
      <div
        className="absolute inset-0 z-10 cursor-ew-resize touch-none"
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
        title="Drag to scrub · click to seek"
      />

      {/* Beatgrid */}
      {beatMarks && (
        <div className="absolute inset-0 z-20 pointer-events-none">
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
          className="absolute top-0 bottom-0 z-20 pointer-events-none"
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
          className="absolute top-0 bottom-0 z-20 pointer-events-none"
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

