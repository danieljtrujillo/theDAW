/**
 * DJ tab — pro-DJ console (see MIX.png). Top: two full-width scrolling-overview
 * waveforms (the hero). Below, five regions edge-to-edge:
 *
 *   SAMPLER rail │ DECK A · MIXER · DECK B │ SOURCE TREE
 *                │ FX/STEMS-A · TRACK BROWSER · FX/STEMS-B │
 *
 * Decks carry their own header (art · title · BPM/KEY/Camelot · elapsed/remain),
 * a jog wheel with an inner PITCH fader, a compact transport, and the hotcue /
 * loop / roll / beat-jump performance pads. The narrow center MIXER holds GAIN,
 * 3-band EQ + single-knob FILTER, channel VOL faders, the crossfader, the
 * quantize / auto-gain toggles and the harmonic key-match chip. The center-
 * bottom TRACK BROWSER lists the selected source (the live Library or a set)
 * as a table; rows drag onto a deck or load via →A / →B. The right SOURCE TREE
 * selects what the browser shows. FX-rack / STEMS / sampler are scaffolded
 * (D4/D5) and tagged "soon" — laid out, not faked.
 *
 * Every below-waveform control is on the SLIDE surface (SlideKnob / SlideFader /
 * SlidePad / SlideCrossfader / RoundToggle) + the JogWheel — all lag-free. The
 * engine (djEngine) is the real 2-deck AudioBuffer transport. Per-deck logic
 * lives in `useDeck`, shared by the waveform lane and the deck column.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Disc, Play, Pause, Plus, Save, Trash2, Cast, Music2,
  ChevronDown, ChevronRight, Repeat, Magnet, Gauge, Lock,
  KeyRound, Pencil, Search, Library as LibraryIcon, ListMusic, Layers, Sparkles, Download, Link2, Loader2, Shield, Headphones, Piano, X,
} from 'lucide-react';
import { subscribeToMidi } from '../state/midiBus';
import { useDjControlMap, sigLabel, type MidiKind } from '../state/djControlMap';
import { useAppUiStore } from '../state/appUiStore';
import { useSetlistStore, type SetlistEntry } from '../state/setlistStore';
import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { useDjCuesStore, HOTCUE_SLOTS } from '../state/djCuesStore';
import { toCamelot, keyLabel } from '../lib/camelot';
import { buildBeatgrid } from '../lib/beatgrid';
import { rgb, rgba, type RGB } from '../lib/trackColor';
import { WaveformPreview } from '../components/audio/WaveformPreview';
import { SlideKnob } from '../components/audio/SlideKnob';
import { SlideFader } from '../components/audio/SlideFader';
import { SlidePad } from '../components/audio/SlidePad';
import { SlideCrossfader } from '../components/audio/SlideCrossfader';
import { RoundToggle } from '../components/audio/RoundToggle';
import { JogWheel } from '../components/audio/JogWheel';
import { sendSetToVj, sendTrackToVj, isVjSetTargetActive, type VjSetItem } from '../state/vjSetBus';
import { registerDjMasterHandler, reportDjMasterState } from '../state/djMasterBus';
import { importUrlToLibrary } from '../lib/onlineImport';
import { ensureStems } from '../lib/djStems';
import * as djEngine from '../state/djEngine';

const DJ_TRACK_MIME = 'application/x-thedaw-djtrack';

const DECK_RGB: Record<'purple' | 'cyan', RGB> = { purple: [168, 85, 247], cyan: [34, 211, 238] };

const BEAT_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' }, { beats: 0.5, label: '½' }, { beats: 1, label: '1' }, { beats: 2, label: '2' }, { beats: 4, label: '4' },
];
const ROLL_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' }, { beats: 0.5, label: '½' }, { beats: 1, label: '1' },
];
const AUTO_GAIN_TARGET_DB = -12;
const AUTOMIX_TAIL = 18;   // s before a track ends to begin the blend
const AUTOMIX_XFADE = 10;  // s the auto-crossfade takes

/* DJ MIDI-learn (D6): the bindable actions, grouped for the map panel. CC →
 * continuous (xfader/vol/eq/filter/pitch); note → trigger (play/cue/sync/hotcue). */
const deckMidiActions = (d: 'A' | 'B'): Array<{ id: string; label: string; group: string; kind: MidiKind }> =>
  ([
    { id: `play${d}`, label: 'Play', kind: 'note' as MidiKind },
    { id: `cue${d}`, label: 'Cue', kind: 'note' as MidiKind },
    { id: `sync${d}`, label: 'Sync', kind: 'note' as MidiKind },
    { id: `headcue${d}`, label: 'Cue (HP)', kind: 'note' as MidiKind },
    { id: `vol${d}`, label: 'Volume', kind: 'cc' as MidiKind },
    { id: `filter${d}`, label: 'Filter', kind: 'cc' as MidiKind },
    { id: `pitch${d}`, label: 'Pitch', kind: 'cc' as MidiKind },
    { id: `eq${d}.high`, label: 'EQ Hi', kind: 'cc' as MidiKind },
    { id: `eq${d}.mid`, label: 'EQ Mid', kind: 'cc' as MidiKind },
    { id: `eq${d}.low`, label: 'EQ Lo', kind: 'cc' as MidiKind },
    ...[1, 2, 3, 4].map((n) => ({ id: `hotcue${d}${n}`, label: `Hotcue ${n}`, kind: 'note' as MidiKind })),
  ]).map((a) => ({ ...a, group: `Deck ${d}` }));

const MIDI_ACTIONS: Array<{ id: string; label: string; group: string; kind: MidiKind }> = [
  { id: 'xfader', label: 'Crossfader', group: 'Mixer', kind: 'cc' },
  ...deckMidiActions('A'),
  ...deckMidiActions('B'),
];

/** Source feeding the center Track Browser. */
type Source = { kind: 'library' } | { kind: 'set'; id: string };

/* ═══════════════════════════ per-deck controller ═══════════════════════════ */

function useDeck(deckId: djEngine.DeckId, entryId: string | null, hasTrack: boolean, quantize: boolean, autoGain: boolean, manualGain: number) {
  const ensureAnalyzed = useDjAnalysisStore((s) => s.ensureAnalyzed);
  const analysisEntry = useDjAnalysisStore((s) => (entryId ? s.byId[entryId] ?? null : null));
  useEffect(() => { if (entryId) void ensureAnalyzed(entryId); }, [entryId, ensureAnalyzed]);

  const a = analysisEntry?.data ?? null;
  const analyzing = analysisEntry?.status === 'running';
  const cam = a ? toCamelot(a.key, a.scale) : null;
  const bpm = a?.bpm ?? null;
  const beats = a?.beats ?? null;
  const beatLen = bpm && bpm > 0 ? 60 / bpm : null;
  const grid = useMemo(() => buildBeatgrid({ bpm, beats, duration: a?.duration_sec }), [bpm, beats, a?.duration_sec]);
  const gridBeats = grid?.beats ?? beats;
  const firstBeat = beats && beats.length > 0 ? beats[0] : null;

  const cues = useDjCuesStore((s) => (entryId ? s.byEntry[entryId] : undefined));
  const setCue = useDjCuesStore((s) => s.setCue);
  const clearCue = useDjCuesStore((s) => s.clearCue);

  const [loopActive, setLoopActiveSt] = useState(false);
  const [activeLoopBeats, setActiveLoopBeats] = useState<number | null>(null);
  const [slip, setSlipSt] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [keylock, setKeylockSt] = useState(false);
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    setLoopActiveSt((p) => (p === st.loopActive ? p : st.loopActive));
    setSlipSt((p) => (p === st.slip ? p : st.slip));
    setDecoding((p) => (p === st.decoding ? p : st.decoding));
    setKeylockSt((p) => (p === st.keylock ? p : st.keylock));
  }), [deckId]);
  useEffect(() => { if (!loopActive) setActiveLoopBeats(null); }, [loopActive]);

  const autoCuedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!entryId || autoCuedRef.current === entryId) return;
    if (firstBeat == null || firstBeat <= 0.05) return;
    const st = djEngine.getStatus(deckId);
    if (st.duration <= 0) return;
    if (!st.playing && st.currentTime <= 0.05) djEngine.seekDeck(deckId, firstBeat);
    autoCuedRef.current = entryId;
  }, [entryId, firstBeat, deckId, decoding]);

  // Trim follows loudness-matched auto-gain when enabled, else the manual GAIN knob.
  const autoTrim = a?.rms_db != null ? Math.max(-15, Math.min(15, AUTO_GAIN_TARGET_DB - a.rms_db)) : 0;
  const trimDb = autoGain ? autoTrim : manualGain;
  useEffect(() => { djEngine.setDeckTrim(deckId, trimDb); }, [deckId, trimDb]);

  const setHotcue = (i: number) => {
    if (!entryId) return;
    const c = cues?.[i] ?? null;
    if (c == null) { const pos = djEngine.getStatus(deckId).currentTime; setCue(entryId, i, quantize ? nearestBeat(pos, gridBeats) : pos); }
    else djEngine.seekDeck(deckId, quantize ? nearestBeat(c, gridBeats) : c);
  };
  const dropHotcue = (i: number) => { if (entryId) clearCue(entryId, i); };

  const effBeatLen = beatLen ?? 0.5;
  const toggleBeatLoop = (loopBeats: number) => {
    if (!hasTrack) return;
    if (loopActive && activeLoopBeats === loopBeats) { djEngine.exitLoop(deckId); return; }
    const len = loopBeats * effBeatLen;
    const pos = djEngine.getStatus(deckId).currentTime;
    let inPt = pos;
    if (gridBeats && gridBeats.length) {
      const anchor = snapToBeat(pos, gridBeats);
      inPt = anchor;
      if (loopBeats < 1 && len > 0) inPt = anchor + Math.max(0, Math.floor((pos - anchor) / len)) * len;
    }
    djEngine.setLoop(deckId, inPt, inPt + len);
    setActiveLoopBeats(loopBeats);
  };
  const rollDown = (loopBeats: number) => { if (hasTrack) djEngine.startLoopRoll(deckId, loopBeats * effBeatLen); };
  const rollUp = () => djEngine.endLoopRoll(deckId);
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

  return {
    a, analyzing, cam, bpm, beats, beatLen, gridBeats, firstBeat, cues, trimDb,
    loopActive, activeLoopBeats, slip, decoding, keylock,
    setHotcue, dropHotcue, toggleBeatLoop, rollDown, rollUp, beatJump,
    exitLoop: () => djEngine.exitLoop(deckId),
    setKeylock: (on: boolean) => void djEngine.setDeckKeylock(deckId, on),
    setSlip: (on: boolean) => djEngine.setSlip(deckId, on),
  };
}

type DeckCtl = ReturnType<typeof useDeck>;

/* ═══════════════════════════════ DJView ════════════════════════════════════ */

export const DJView: React.FC = () => {
  const [deckATrack, setDeckATrack] = useState<string | null>(null);
  const [deckBTrack, setDeckBTrack] = useState<string | null>(null);
  const [deckAPlaying, setDeckAPlaying] = useState(false);
  const [deckBPlaying, setDeckBPlaying] = useState(false);
  const [crossfader, setCrossfader] = useState(() => djEngine.getCrossfade());
  const [deckAPitch, setDeckAPitch] = useState(0);
  const [deckBPitch, setDeckBPitch] = useState(0);
  const [syncLock, setSyncLock] = useState<djEngine.DeckId | null>(null);
  const [quantize, setQuantize] = useState(false);
  const [autoGain, setAutoGain] = useState(true);
  const [gainA, setGainA] = useState(0);
  const [gainB, setGainB] = useState(0);
  const [eqA, setEqA] = useState({ low: 0, mid: 0, high: 0 });
  const [eqB, setEqB] = useState({ low: 0, mid: 0, high: 0 });
  const [filterA, setFilterA] = useState(0);
  const [filterB, setFilterB] = useState(0);
  const [volA, setVolA] = useState(1);
  const [volB, setVolB] = useState(1);
  const [cueA, setCueA] = useState(false);
  const [cueB, setCueB] = useState(false);
  const [midiMapOpen, setMidiMapOpen] = useState(false);
  const [automixOn, setAutomixOn] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const automixRef = useRef<{ current: djEngine.DeckId; fading: boolean; fadeStart: number; fadeFrom: number; fadeTo: number } | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'library' });

  const entries = useLibraryStore((s) => s.entries);
  const analyzeAll = useDjAnalysisStore((s) => s.analyzeAll);
  const djTabActive = useAppUiStore((s) => s.centerTab === 'dj');
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const appendToSet = useSetlistStore((s) => s.append);
  const activeSet = activeId ? setlists[activeId] : null;

  const trackById = (id: string | null): LibraryEntry | null => (id ? entries.find((e) => e.id === id) ?? null : null);
  const deckATitle = trackById(deckATrack)?.title ?? null;
  const deckBTitle = trackById(deckBTrack)?.title ?? null;
  const deckAUrl = trackById(deckATrack)?.audioUrl ?? null;
  const deckBUrl = trackById(deckBTrack)?.audioUrl ?? null;

  const ctlA = useDeck('A', deckATrack, !!deckATrack, quantize, autoGain, gainA);
  const ctlB = useDeck('B', deckBTrack, !!deckBTrack, quantize, autoGain, gainB);

  const camA = ctlA.cam;
  const camB = ctlB.cam;
  const harmonic = camA && camB ? camA.compatible.includes(camB.code) : null;
  const canSync = !!ctlA.a?.bpm && !!ctlB.a?.bpm;

  const deckATrackRef = useRef<string | null>(deckATrack);
  const deckBTrackRef = useRef<string | null>(deckBTrack);
  deckATrackRef.current = deckATrack;
  deckBTrackRef.current = deckBTrack;
  const pendingPlayRef = useRef<djEngine.DeckId | null>(null);
  const masterPlayingRef = useRef(false);

  const loadDeck = (entryId: string, deck: djEngine.DeckId) => { if (deck === 'A') setDeckATrack(entryId); else setDeckBTrack(entryId); };

  useEffect(() => {
    return djEngine.subscribe((a, b) => {
      setDeckAPlaying(a.playing);
      setDeckBPlaying(b.playing);
      const pend = pendingPlayRef.current;
      if (pend) {
        const st = pend === 'A' ? a : b;
        if (st.hasBuffer && !st.decoding && !st.playing) { djEngine.playDeck(pend); pendingPlayRef.current = null; }
      }
      const playing = a.playing || b.playing;
      if (playing !== masterPlayingRef.current) { masterPlayingRef.current = playing; reportDjMasterState(playing ? 'playing' : 'paused'); }
    });
  }, []);

  useEffect(() => {
    const startSet = () => {
      const aHas = !!deckATrackRef.current;
      const bHas = !!deckBTrackRef.current;
      if (aHas || bHas) { if (aHas) djEngine.playDeck('A'); if (bHas) djEngine.playDeck('B'); return; }
      const sl = useSetlistStore.getState();
      const set = sl.activeId ? sl.setlists[sl.activeId] : null;
      const first = set?.entries.find((e) => e.entryId) ?? null;
      if (first?.entryId) { pendingPlayRef.current = 'A'; setDeckATrack(first.entryId); }
    };
    return registerDjMasterHandler({
      toggle: () => {
        const aPlaying = djEngine.getStatus('A').playing;
        const bPlaying = djEngine.getStatus('B').playing;
        if (aPlaying || bPlaying) { if (aPlaying) djEngine.pauseDeck('A'); if (bPlaying) djEngine.pauseDeck('B'); reportDjMasterState('paused'); }
        else { startSet(); reportDjMasterState('playing'); }
      },
      getState: () => djEngine.getStatus('A').playing || djEngine.getStatus('B').playing ? 'playing' : 'paused',
    });
  }, []);

  useEffect(() => { if (djTabActive && entries.length) void analyzeAll(entries.map((e) => e.id)); }, [djTabActive, entries, analyzeAll]);

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

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const addDeckToSet = (which: 'A' | 'B') => {
    if (!activeId) { setFlash('Create a set first (Lists & Advice ›)'); return; }
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    appendToSet(activeId, [{ entryId: track.id, label: track.title, kind: 'audio' }]);
    setFlash(`Added "${track.title}" to ${activeSet?.name ?? 'set'}`);
  };
  const sendDeckToVj = (which: 'A' | 'B') => {
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    sendTrackToVj({ entryId: track.id, label: track.title, url: track.audioUrl, kind: 'audio' });
    setFlash(isVjSetTargetActive() ? `Sent "${track.title}" to VJ` : `Queued "${track.title}" — opens with VJ tab`);
  };

  const syncDeck = (which: djEngine.DeckId) => {
    const thisCtl = which === 'A' ? ctlA : ctlB;
    const otherCtl = which === 'A' ? ctlB : ctlA;
    const otherId: djEngine.DeckId = which === 'A' ? 'B' : 'A';
    const thisBpm = thisCtl.a?.bpm ?? null;
    const otherBpm = otherCtl.a?.bpm ?? null;
    if (!thisBpm || !otherBpm) return;
    const otherPitch = which === 'A' ? deckBPitch : deckAPitch;
    const otherEffBpm = otherBpm * (1 + otherPitch / 100);
    let rate = otherEffBpm / thisBpm;
    while (rate > Math.SQRT2) rate /= 2;
    while (rate < Math.SQRT1_2) rate *= 2;
    const pct = (rate - 1) * 100;
    if (which === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    djEngine.setDeckPitch(which, pct);
    const thisBeats = thisCtl.a?.beats ?? null;
    const otherBeats = otherCtl.a?.beats ?? null;
    const otherStatus = djEngine.getStatus(otherId);
    const thisStatus = djEngine.getStatus(which);
    if (thisBeats && otherBeats && otherStatus.playing) {
      const interval = 60 / (thisBpm * rate);
      let delta = (beatPhase(otherStatus.currentTime, otherBeats) - beatPhase(thisStatus.currentTime, thisBeats)) * interval;
      if (delta > interval / 2) delta -= interval;
      if (delta < -interval / 2) delta += interval;
      djEngine.seekDeck(which, thisStatus.currentTime + delta);
    }
    setFlash(`Synced Deck ${which} → ${otherEffBpm.toFixed(1)} BPM`);
  };
  const toggleSyncLock = (which: djEngine.DeckId) => {
    if (syncLock === which) { setSyncLock(null); return; }
    syncDeck(which);
    setSyncLock(which);
    setFlash(`Sync-Lock: Deck ${which} follows Deck ${which === 'A' ? 'B' : 'A'}`);
  };

  const aData = ctlA.a;
  const bData = ctlB.a;
  useEffect(() => {
    if (!syncLock) return;
    const follower = syncLock;
    const fBpm = (follower === 'A' ? aData : bData)?.bpm ?? null;
    const mBpm = (follower === 'A' ? bData : aData)?.bpm ?? null;
    const fBeats = (follower === 'A' ? aData : bData)?.beats ?? null;
    const mBeats = (follower === 'A' ? bData : aData)?.beats ?? null;
    if (!fBpm || !mBpm || !fBeats || !mBeats) return;
    const KP = 12, MAX_BEND = 4, DEADBAND = 0.02;
    const master: djEngine.DeckId = follower === 'A' ? 'B' : 'A';
    const id = window.setInterval(() => {
      const fs = djEngine.getStatus(follower);
      const ms = djEngine.getStatus(master);
      if (!fs.playing || !ms.playing) return;
      const mEff = mBpm * (1 + ms.pitchPct / 100);
      let rate = mEff / fBpm;
      while (rate > Math.SQRT2) rate /= 2;
      while (rate < Math.SQRT1_2) rate *= 2;
      let dPhase = beatPhase(ms.currentTime, mBeats) - beatPhase(fs.currentTime, fBeats);
      if (dPhase > 0.5) dPhase -= 1;
      if (dPhase < -0.5) dPhase += 1;
      const bend = Math.abs(dPhase) > DEADBAND ? Math.max(-MAX_BEND, Math.min(MAX_BEND, dPhase * KP)) : 0;
      const pct = Math.max(-50, Math.min(50, (rate - 1) * 100 + bend));
      djEngine.setDeckPitch(follower, pct);
      if (follower === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    }, 350);
    return () => window.clearInterval(id);
  }, [syncLock, aData, bData]);

  const onPitch = (which: djEngine.DeckId, v: number) => {
    if (syncLock === which) setSyncLock(null);
    if (which === 'A') setDeckAPitch(v); else setDeckBPitch(v);
    djEngine.setDeckPitch(which, v);
  };
  const onEq = (which: djEngine.DeckId, band: 'low' | 'mid' | 'high', v: number) => {
    if (which === 'A') setEqA((p) => ({ ...p, [band]: v })); else setEqB((p) => ({ ...p, [band]: v }));
    djEngine.setDeckEq(which, band, v);
  };
  const onFilter = (which: djEngine.DeckId, v: number) => { if (which === 'A') setFilterA(v); else setFilterB(v); djEngine.setDeckFilter(which, v); };
  const onVol = (which: djEngine.DeckId, v: number) => { if (which === 'A') setVolA(v); else setVolB(v); djEngine.setDeckVolume(which, v); };
  const onGain = (which: djEngine.DeckId, v: number) => { if (which === 'A') setGainA(v); else setGainB(v); };
  const toggleCue = (which: djEngine.DeckId) => {
    const next = which === 'A' ? !cueA : !cueB;
    if (which === 'A') setCueA(next); else setCueB(next);
    djEngine.setDeckCue(which, next);
  };
  const applyCrossfade = (v: number) => { setCrossfader(v); djEngine.setCrossfade(v); };

  // DJ MIDI-learn (D6): rebuild the action→handler map each render (cheap; closes
  // over current state) and read it from a ref inside the one midiBus subscriber.
  const midiHandlersRef = useRef<Record<string, (v: number) => void>>({});
  midiHandlersRef.current = (() => {
    const h: Record<string, (v: number) => void> = { xfader: (v) => applyCrossfade((v / 127) * 2 - 1) };
    for (const d of ['A', 'B'] as djEngine.DeckId[]) {
      const ctl = d === 'A' ? ctlA : ctlB;
      h[`play${d}`] = () => djEngine.toggleDeck(d);
      h[`cue${d}`] = () => djEngine.cueDeck(d);
      h[`sync${d}`] = () => syncDeck(d);
      h[`headcue${d}`] = () => toggleCue(d);
      h[`vol${d}`] = (v) => onVol(d, v / 127);
      h[`filter${d}`] = (v) => onFilter(d, (v / 127) * 2 - 1);
      h[`pitch${d}`] = (v) => onPitch(d, (v / 127) * 100 - 50);
      h[`eq${d}.high`] = (v) => onEq(d, 'high', (v / 127) * 24 - 12);
      h[`eq${d}.mid`] = (v) => onEq(d, 'mid', (v / 127) * 24 - 12);
      h[`eq${d}.low`] = (v) => onEq(d, 'low', (v / 127) * 24 - 12);
      for (const n of [1, 2, 3, 4]) h[`hotcue${d}${n}`] = () => ctl.setHotcue(n - 1);
    }
    return h;
  })();
  useEffect(() => {
    return subscribeToMidi((msg) => {
      const data = msg.data;
      if (!data || data.length < 2) return;
      const status = data[0] & 0xf0;
      const channel = data[0] & 0x0f;
      const number = data[1];
      const value = data.length > 2 ? data[2] : 0;
      const kind: MidiKind | null = status === 0xb0 ? 'cc' : (status === 0x90 || status === 0x80) ? 'note' : null;
      if (!kind) return;
      const store = useDjControlMap.getState();
      if (store.learnAction) { store.bind(store.learnAction, { kind, number, channel }); return; }
      for (const actionId in store.bindings) {
        const sig = store.bindings[actionId];
        if (sig.kind !== kind || sig.number !== number || sig.channel !== channel) continue;
        const fn = midiHandlersRef.current[actionId];
        if (!fn) continue;
        if (kind === 'note') { if (status === 0x90 && value > 0) fn(value); }
        else fn(value);
      }
    });
  }, []);

  // Automix (D7): auto-sequence the active set across the 2 decks — beatmatch
  // the next track and crossfade at each tail, then advance. Pure orchestration
  // over the existing engine (no new deps). Drives the real deck loaders + sync.
  useEffect(() => {
    if (!automixOn) { automixRef.current = null; return; }
    const seq = (): string[] => {
      const sl = useSetlistStore.getState();
      const set = sl.activeId ? sl.setlists[sl.activeId] : null;
      return (set?.entries ?? []).map((e) => e.entryId).filter((x): x is string => !!x);
    };
    const list = seq();
    if (list.length < 2) { setFlash('Automix needs an active set with ≥2 tracks'); setAutomixOn(false); return; }
    const other = (d: djEngine.DeckId): djEngine.DeckId => (d === 'A' ? 'B' : 'A');
    const loadOnto = (d: djEngine.DeckId, entryId: string) => (d === 'A' ? setDeckATrack : setDeckBTrack)(entryId);
    const loadNextAfter = (entryId: string | null, onto: djEngine.DeckId) => {
      const l = seq();
      const i = entryId ? l.indexOf(entryId) : -1;
      const ni = i >= 0 ? i + 1 : 1;
      if (ni < l.length && l[ni] !== deckATrackRef.current && l[ni] !== deckBTrackRef.current) loadOnto(onto, l[ni]);
    };

    // Init: current = a playing deck, else Deck A seeded with the first track.
    const current: djEngine.DeckId = djEngine.getStatus('A').playing ? 'A' : djEngine.getStatus('B').playing ? 'B' : 'A';
    const curEntry = current === 'A' ? deckATrackRef.current : deckBTrackRef.current;
    if (!curEntry) { loadOnto(current, list[0]); pendingPlayRef.current = current; }
    automixRef.current = { current, fading: false, fadeStart: 0, fadeFrom: 0, fadeTo: 0 };
    loadNextAfter(curEntry ?? list[0], other(current));
    setFlash('Automix on — sequencing the set');

    const id = window.setInterval(() => {
      const mix = automixRef.current;
      if (!mix) return;
      const cur = mix.current;
      const nxt = other(cur);
      const cs = djEngine.getStatus(cur);
      const ns = djEngine.getStatus(nxt);
      const now = performance.now();
      if (!mix.fading) {
        if (cs.playing && cs.duration > 0 && cs.duration - cs.currentTime <= AUTOMIX_TAIL && ns.hasBuffer) {
          syncDeck(nxt);              // beatmatch the incoming deck to the outgoing tempo + phase
          djEngine.seekDeck(nxt, 0);
          djEngine.playDeck(nxt);
          mix.fading = true; mix.fadeStart = now; mix.fadeFrom = djEngine.getCrossfade(); mix.fadeTo = nxt === 'B' ? 1 : -1;
          setFlash(`Automix: blending → Deck ${nxt}`);
        }
      } else {
        const t = Math.min(1, (now - mix.fadeStart) / (AUTOMIX_XFADE * 1000));
        applyCrossfade(mix.fadeFrom + (mix.fadeTo - mix.fadeFrom) * t);
        if (t >= 1 || !cs.playing) {
          if (cs.playing) djEngine.pauseDeck(cur);
          mix.current = nxt;
          mix.fading = false;
          loadNextAfter(nxt === 'A' ? deckATrackRef.current : deckBTrackRef.current, cur); // queue the following track on the freed deck
        }
      }
    }, 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automixOn]);

  return (
    <div className="h-full w-full overflow-hidden flex flex-col gap-1.5 p-1.5 bg-[#07050a] text-white">

      {/* ═══ TOP: dual scrolling-overview waveforms (hero) ═══ */}
      <div className="shrink-0 flex flex-col gap-1.5" style={{ height: 138 }}>
        <WaveLane deckId="A" accent="purple" entryId={deckATrack} hasTrack={!!deckATrack} audioUrl={deckAUrl} ctl={ctlA} onLoadId={(id) => setDeckATrack(id)} />
        <WaveLane deckId="B" accent="cyan" entryId={deckBTrack} hasTrack={!!deckBTrack} audioUrl={deckBUrl} ctl={ctlB} onLoadId={(id) => setDeckBTrack(id)} />
      </div>

      {/* ═══ BELOW: sampler rail │ center (decks/mixer + racks/browser) │ source tree ═══ */}
      <div className="flex-1 min-h-0 grid gap-1.5" style={{ gridTemplateColumns: '186px minmax(0,1fr) 210px' }}>
        <SamplerRail />

        <div className="min-h-0 flex flex-col gap-1.5">
          {/* decks + mixer */}
          <div className="flex-1 min-h-0 grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) 168px minmax(0,1fr)' }}>
            <DeckColumn deckId="A" accent="purple" ctl={ctlA} title={deckATitle} cam={camA} hasTrack={!!deckATrack} isPlaying={deckAPlaying} pitch={deckAPitch} onPitch={(v) => onPitch('A', v)} onPlay={() => djEngine.toggleDeck('A')} onCue={() => djEngine.cueDeck('A')} onSync={() => syncDeck('A')} onSyncLock={() => toggleSyncLock('A')} syncLocked={syncLock === 'A'} canSync={canSync} onSendVj={() => sendDeckToVj('A')} onAddSet={() => addDeckToSet('A')} headCued={cueA} onHeadCue={() => toggleCue('A')} />
            <Mixer
              gainA={gainA} gainB={gainB} eqA={eqA} eqB={eqB} filterA={filterA} filterB={filterB} volA={volA} volB={volB}
              onGain={onGain} onEq={onEq} onFilter={onFilter} onVol={onVol}
              crossfader={crossfader} onCrossfade={applyCrossfade}
              quantize={quantize} setQuantize={setQuantize} autoGain={autoGain} setAutoGain={setAutoGain}
              camA={camA} camB={camB} harmonic={harmonic} flash={flash}
              midiMapOn={midiMapOpen} onToggleMidiMap={() => setMidiMapOpen((v) => !v)}
              automixOn={automixOn} onToggleAutomix={() => setAutomixOn((v) => !v)}
            />
            <DeckColumn deckId="B" accent="cyan" ctl={ctlB} title={deckBTitle} cam={camB} hasTrack={!!deckBTrack} isPlaying={deckBPlaying} mirror pitch={deckBPitch} onPitch={(v) => onPitch('B', v)} onPlay={() => djEngine.toggleDeck('B')} onCue={() => djEngine.cueDeck('B')} onSync={() => syncDeck('B')} onSyncLock={() => toggleSyncLock('B')} syncLocked={syncLock === 'B'} canSync={canSync} onSendVj={() => sendDeckToVj('B')} onAddSet={() => addDeckToSet('B')} headCued={cueB} onHeadCue={() => toggleCue('B')} />
          </div>
          {/* FX/STEMS racks flanking the track browser */}
          <div className="shrink-0 grid gap-1.5" style={{ gridTemplateColumns: '168px minmax(0,1fr) 168px', height: 176 }}>
            <DeckRack deck="A" accent="purple" entryId={deckATrack} />
            <TrackBrowser source={source} setSource={setSource} onLoadDeck={loadDeck} />
            <DeckRack deck="B" accent="cyan" entryId={deckBTrack} />
          </div>
        </div>

        <SourceTree source={source} setSource={setSource} libCount={entries.length} />
      </div>

      {midiMapOpen && <DjMidiMap onClose={() => { setMidiMapOpen(false); useDjControlMap.getState().arm(null); }} />}
    </div>
  );
};

/* ═══════════════════════════════ WaveLane ═══════════════════════════════════ */

interface WaveLaneProps {
  deckId: djEngine.DeckId; accent: 'purple' | 'cyan'; entryId: string | null;
  hasTrack: boolean; audioUrl: string | null; ctl: DeckCtl; onLoadId: (id: string) => void;
}

const WaveLane: React.FC<WaveLaneProps> = ({ deckId, accent, hasTrack, audioUrl, ctl, onLoadId }) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const accentBorder = accent === 'purple' ? 'border-purple-500/30' : 'border-cyan-500/30';
  const [dropHover, setDropHover] = useState(false);
  return (
    <div
      className={`flex-1 min-h-0 relative rounded-lg border ${accentBorder} bg-black/40 overflow-hidden ${dropHover ? 'ring-2 ring-inset ring-white/50' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(DJ_TRACK_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropHover(true); } }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => { setDropHover(false); const id = e.dataTransfer.getData(DJ_TRACK_MIME); if (id) { e.preventDefault(); onLoadId(id); } }}
    >
      <span className={`absolute top-1 left-2 z-30 flex items-center gap-1 text-[8px] font-black uppercase tracking-[0.18em] pointer-events-none ${accentText}`}>
        <Disc className="w-2.5 h-2.5" /> Deck {deckId} · overview
      </span>
      {audioUrl ? <DeckWaveform deckId={deckId} audioUrl={audioUrl} beats={ctl.gridBeats} cues={ctl.cues ?? null} accent={accent} height={62} />
        : <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-700">{hasTrack ? '…' : 'drag a track here from the browser →'}</div>}
    </div>
  );
};

/* ═══════════════════════════════ SamplerRail ════════════════════════════════ */

const SAMPLER_PADS: Array<{ k: string; name: string }> = [
  { k: 'F', name: 'Hi Horn' }, { k: 'S', name: 'Siren' },
  { k: 'X', name: 'Zap' }, { k: 'A', name: 'Sample' },
  { k: 'P', name: 'Laser' }, { k: 'L', name: 'Impact' },
  { k: 'A', name: 'La La' }, { k: 'E', name: 'Uplifter' },
  { k: 'S', name: 'Stabs' }, { k: 'X', name: 'Noise' },
];

const SamplerRail: React.FC = () => (
  <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
    <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
      <Sparkles className="w-3 h-3 text-amber-300 shrink-0" />
      <span className="text-[9px] font-black uppercase tracking-wider text-amber-200 leading-tight">Sampler / FX Pads</span>
      <span className="ml-auto text-[7px] font-bold uppercase tracking-wider text-zinc-600 px-1 py-0.5 rounded bg-white/5">soon</span>
    </div>
    <div className="flex-1 min-h-0 grid grid-cols-2 gap-1 p-1.5 content-start">
      {SAMPLER_PADS.map((p, i) => (
        <button key={i} type="button" title="Sampler / audio-FX pad — coming soon (D5)"
          className="flex flex-col items-center justify-center gap-0.5 rounded-md border border-white/10 bg-black/40 py-1.5 text-zinc-500 hover:text-zinc-300 hover:border-white/20 transition-colors">
          <span className="text-[13px] font-black leading-none text-zinc-300">{p.k}</span>
          <span className="text-[7px] font-mono uppercase tracking-wide text-zinc-600 leading-none">{p.name}</span>
        </button>
      ))}
    </div>
    <div className="shrink-0 grid grid-cols-4 gap-1 px-1.5 pb-1.5">
      {['Bank', 'Hold', 'Roll', 'Mode'].map((b) => (
        <div key={b} className="rounded border border-white/8 bg-black/30 py-1 text-center text-[7px] font-mono uppercase tracking-wide text-zinc-700" title="Pad bank / mode controls — coming soon">{b}</div>
      ))}
    </div>
  </div>
);

/* ═══════════════════════════════ DeckColumn ═════════════════════════════════ */

interface DeckColumnProps {
  deckId: djEngine.DeckId; accent: 'purple' | 'cyan'; ctl: DeckCtl; title: string | null;
  cam: ReturnType<typeof toCamelot> | null; hasTrack: boolean; isPlaying: boolean; mirror?: boolean;
  pitch: number; onPitch: (v: number) => void; onPlay: () => void; onCue: () => void;
  onSync: () => void; onSyncLock: () => void; syncLocked: boolean; canSync: boolean;
  onSendVj: () => void; onAddSet: () => void;
  headCued: boolean; onHeadCue: () => void;
}

const PAD_SM = 'px-1.5 py-1 text-[8px] min-w-0';

const DeckColumn: React.FC<DeckColumnProps> = ({
  deckId, accent, ctl, title, cam, hasTrack, isPlaying, mirror, pitch, onPitch,
  onPlay, onCue, onSync, onSyncLock, syncLocked, canSync, onSendVj, onAddSet, headCued, onHeadCue,
}) => {
  const rgbc = DECK_RGB[accent];
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const effBpm = ctl.bpm != null ? (ctl.bpm * (1 + pitch / 100)).toFixed(1) : null;

  const header = (
    <div className={`shrink-0 flex items-center gap-1.5 ${mirror ? 'flex-row-reverse' : ''}`}>
      <div className="shrink-0 grid place-items-center rounded border w-7 h-7" style={{ borderColor: rgba(rgbc, 0.4), background: rgba(rgbc, 0.12) }} title={`Deck ${deckId}`}>
        <Music2 className="w-3.5 h-3.5" style={{ color: rgb(rgbc) }} />
      </div>
      <div className={`min-w-0 flex-1 flex flex-col ${mirror ? 'items-end text-right' : ''}`}>
        <span className="text-[10px] font-bold text-zinc-200 truncate max-w-full leading-tight" title={title ?? ''}>{title ?? 'Empty deck'}</span>
        <DeckTimes deckId={deckId} mirror={mirror} />
      </div>
      <div className={`shrink-0 flex flex-col gap-0.5 items-center font-mono`}>
        <span className="px-1 py-0.5 rounded bg-black/40 border border-white/10 text-[8px] text-zinc-300 tabular-nums whitespace-nowrap"><span className="text-zinc-600">BPM </span>{ctl.bpm != null ? ctl.bpm.toFixed(1) : (ctl.analyzing ? '…' : '—')}</span>
        {cam ? (
          <span className="px-1 py-0.5 rounded text-[8px] font-black border whitespace-nowrap" style={{ color: `hsl(${cam.hue} 80% 75%)`, borderColor: `hsl(${cam.hue} 70% 45% / 0.6)`, background: `hsl(${cam.hue} 70% 45% / 0.12)` }} title={`Camelot ${cam.code} — mixes with ${cam.compatible.join(', ')}`}>{cam.code}</span>
        ) : <span className="px-1 py-0.5 rounded bg-black/40 border border-white/10 text-[8px] text-zinc-600">KEY {ctl.a?.key ? keyLabel(ctl.a.key, ctl.a.scale) : '—'}</span>}
      </div>
      <div className="shrink-0 flex flex-col gap-0.5">
        <button onClick={onSendVj} disabled={!hasTrack} className="p-0.5 text-zinc-600 hover:text-cyan-300 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Send this deck's track to the VJ"><Cast className="w-3 h-3" /></button>
        <button onClick={onAddSet} disabled={!hasTrack} className="p-0.5 text-zinc-600 hover:text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Add this deck's track to the active set"><Save className="w-3 h-3" /></button>
      </div>
    </div>
  );

  const pitchCol = (
    <div className="shrink-0 flex flex-col items-center gap-0.5 w-10 min-h-0">
      <div className="flex-1 min-h-0 w-full flex justify-center"><SlideFader label={`Pitch ${deckId}`} value={pitch} onChange={onPitch} min={-50} max={50} step={0.1} /></div>
      {effBpm && <span className="shrink-0 text-[8px] font-mono tabular-nums text-zinc-500" title="Effective BPM at this pitch">{effBpm}</span>}
    </div>
  );

  const jog = (
    <div className="flex-1 min-h-0"><JogWheel deckId={deckId} color={rgbc} disabled={!hasTrack} fill /></div>
  );
  const PAD_HC = 'w-8 py-1 text-[8px]';
  const PAD_BT = 'w-7 py-1 text-[8px]';

  return (
    <div className="hardware-card flex flex-col gap-1.5 p-1.5 min-h-0 overflow-hidden">
      {header}

      {/* jog wheel (fills, inner edge) + pitch fader (outer edge) */}
      <div className="flex-1 min-h-0 flex gap-1.5 items-stretch">
        {mirror ? <>{jog}{pitchCol}</> : <>{pitchCol}{jog}</>}
      </div>

      {/* transport — compact, centered */}
      <div className="shrink-0 flex items-center justify-center gap-1">
        <SlidePad color={rgbc} disabled={!hasTrack} onClick={onCue} className={PAD_SM} title="Cue to start">Cue</SlidePad>
        <SlidePad color={rgbc} disabled={!hasTrack} onClick={onPlay} className="px-3 py-1" title={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}</SlidePad>
        <SlidePad color={rgbc} disabled={!canSync} onClick={onSync} className={PAD_SM} title={canSync ? 'Beatmatch this deck to the other (tempo + phase)' : 'SYNC needs BPM on both decks'}>Sync</SlidePad>
        <SlidePad color={rgbc} on={syncLocked} disabled={!canSync} onClick={onSyncLock} className="px-1.5 py-1" title={canSync ? 'Sync-Lock — hold tempo + phase (grab pitch to release)' : 'Sync-Lock needs BPM on both decks'}><Lock className="w-3 h-3" /></SlidePad>
        <SlidePad color={[34, 211, 238]} on={headCued} disabled={!hasTrack} onClick={onHeadCue} className="px-1.5 py-1" title="Cue — pre-listen this deck in the headphone output"><Headphones className="w-3 h-3" /></SlidePad>
        {/* hotcues ride the same row */}
        <span className="w-px h-4 bg-white/10 mx-0.5" />
        {Array.from({ length: HOTCUE_SLOTS }, (_, i) => {
          const c = ctl.cues?.[i] ?? null; const set = c != null;
          return (
            <SlidePad key={i} on={set} color={rgbc} disabled={!hasTrack} className={PAD_HC} onClick={() => ctl.setHotcue(i)} onContextMenu={(e) => { e.preventDefault(); ctl.dropHotcue(i); }} title={set ? `Cue ${i + 1} @ ${fmtTime(c)} — click to jump, right-click to clear` : `Set cue ${i + 1} at the playhead`}>{set ? `▶${i + 1}` : `○${i + 1}`}</SlidePad>
          );
        })}
      </div>

      {/* loop — centered */}
      <div className="shrink-0 flex items-center justify-center gap-1">
        <Repeat className={`w-3 h-3 shrink-0 ${ctl.loopActive ? accentText : 'text-zinc-600'}`} />
        {BEAT_SIZES.map((b) => (<SlidePad key={b.beats} className={PAD_BT} on={ctl.loopActive && ctl.activeLoopBeats === b.beats} color={rgbc} disabled={!hasTrack} onClick={() => ctl.toggleBeatLoop(b.beats)} title={`${b.label}-beat loop`}>{b.label}</SlidePad>))}
        <SlidePad className={PAD_BT} danger disabled={!ctl.loopActive} onClick={ctl.exitLoop} title="Exit loop">Out</SlidePad>
      </div>

      {/* roll · slip · jump · keylock — centered */}
      <div className="shrink-0 flex items-center justify-center gap-1 flex-wrap">
        <span className="text-[7px] font-mono uppercase text-zinc-600">Roll</span>
        {ROLL_SIZES.map((b) => (<SlidePad key={b.beats} className={PAD_BT} color={rgbc} disabled={!hasTrack} onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }} onPointerUp={ctl.rollUp} onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }} title={`${b.label}-beat loop-roll (hold)`}>{b.label}</SlidePad>))}
        <SlidePad className={PAD_BT} on={ctl.slip} color={[245, 158, 11]} disabled={!hasTrack} onClick={() => ctl.setSlip(!ctl.slip)} title="Slip mode">Slip</SlidePad>
        <span className="text-[7px] font-mono uppercase text-zinc-600 ml-0.5">Jump</span>
        {([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).map(([n, lbl]) => (<SlidePad key={n} className={PAD_BT} color={rgbc} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>{lbl}</SlidePad>))}
        <SlidePad className="px-1.5 py-1" on={ctl.keylock} color={rgbc} disabled={!hasTrack} onClick={() => ctl.setKeylock(!ctl.keylock)} title="Key-lock / Master Tempo"><KeyRound className="w-3 h-3" /></SlidePad>
      </div>
    </div>
  );
};

/* elapsed / remaining time — updated imperatively off the engine (no re-render). */
const DeckTimes: React.FC<{ deckId: djEngine.DeckId; mirror?: boolean }> = ({ deckId, mirror }) => {
  const elapRef = useRef<HTMLSpanElement>(null);
  const remRef = useRef<HTMLSpanElement>(null);
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    if (elapRef.current) elapRef.current.textContent = fmtTime(st.currentTime);
    if (remRef.current) remRef.current.textContent = '-' + fmtTime(Math.max(0, st.duration - st.currentTime));
  }), [deckId]);
  return (
    <span className={`flex items-center gap-1.5 text-[8px] font-mono tabular-nums text-zinc-500 leading-tight ${mirror ? 'flex-row-reverse' : ''}`}>
      <span ref={elapRef}>0:00</span>
      <span className="text-zinc-700" ref={remRef}>-0:00</span>
    </span>
  );
};

/* ═══════════════════════════════ Mixer ══════════════════════════════════════ */

interface MixerProps {
  gainA: number; gainB: number;
  eqA: { low: number; mid: number; high: number }; eqB: { low: number; mid: number; high: number };
  filterA: number; filterB: number; volA: number; volB: number;
  onGain: (which: djEngine.DeckId, v: number) => void;
  onEq: (which: djEngine.DeckId, band: 'low' | 'mid' | 'high', v: number) => void;
  onFilter: (which: djEngine.DeckId, v: number) => void; onVol: (which: djEngine.DeckId, v: number) => void;
  crossfader: number; onCrossfade: (v: number) => void;
  quantize: boolean; setQuantize: (v: boolean) => void; autoGain: boolean; setAutoGain: (v: boolean) => void;
  camA: ReturnType<typeof toCamelot> | null; camB: ReturnType<typeof toCamelot> | null; harmonic: boolean | null; flash: string | null;
  midiMapOn: boolean; onToggleMidiMap: () => void;
  automixOn: boolean; onToggleAutomix: () => void;
}

const Mixer: React.FC<MixerProps> = ({
  gainA, gainB, eqA, eqB, filterA, filterB, volA, volB, onGain, onEq, onFilter, onVol,
  crossfader, onCrossfade, quantize, setQuantize, autoGain, setAutoGain, camA, camB, harmonic, flash,
  midiMapOn, onToggleMidiMap, automixOn, onToggleAutomix,
}) => {
  const [limiterOn, setLimiterOn] = useState(() => djEngine.getLimiter());
  // Cue (headphone) output device picker — only when the runtime supports setSinkId.
  const cueSupported = djEngine.isCueSupported();
  const [cueDevices, setCueDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [cueDev, setCueDev] = useState(() => djEngine.getCueSinkId());
  useEffect(() => {
    if (!cueSupported || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices()
      .then((ds) => setCueDevices(ds.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || 'Output' }))))
      .catch(() => { /* ignore — labels need permission, ids still resolve */ });
  }, [cueSupported]);
  // A deck's EQ + filter as a vertical knob column (HI · MID · LO · FLT),
  // spread to fill the channel height alongside the tall VOL fader.
  const eqCol = (which: djEngine.DeckId, eq: { low: number; mid: number; high: number }, filter: number) => (
    <div className="flex flex-col items-center justify-between min-h-0 py-0.5">
      <SlideKnob label="Hi" value={eq.high} onChange={(v) => onEq(which, 'high', v)} min={-12} max={12} step={0.5} size={26} center centerReadout />
      <SlideKnob label="Mid" value={eq.mid} onChange={(v) => onEq(which, 'mid', v)} min={-12} max={12} step={0.5} size={26} center centerReadout />
      <SlideKnob label="Lo" value={eq.low} onChange={(v) => onEq(which, 'low', v)} min={-12} max={12} step={0.5} size={26} center centerReadout />
      <SlideKnob label="Flt" value={filter} onChange={(v) => onFilter(which, v)} min={-1} max={1} step={0.01} size={26} center centerReadout />
    </div>
  );

  return (
    <div className="hardware-card flex flex-col items-center gap-1 p-1.5 min-h-0 overflow-hidden">
      <span className="shrink-0 text-[9px] font-black uppercase tracking-widest text-zinc-400">Mixer</span>

      {/* GAIN A · B */}
      <div className="shrink-0 flex items-center justify-center gap-1" title={autoGain ? 'Channel gain — overridden by Auto-Gain (toggle off to set manually)' : 'Channel gain (trim)'}>
        <SlideKnob label="" value={gainA} onChange={(v) => onGain('A', v)} min={-12} max={12} step={0.5} size={28} center centerReadout />
        <span className="text-[7px] font-mono uppercase text-zinc-500 w-8 text-center">Gain</span>
        <SlideKnob label="" value={gainB} onChange={(v) => onGain('B', v)} min={-12} max={12} step={0.5} size={28} center centerReadout />
      </div>

      {/* EQ/FILTER knob columns flanking the channel VOL faders */}
      <div className="flex-1 min-h-0 w-full flex items-stretch justify-center gap-1">
        {eqCol('A', eqA, filterA)}
        <SlideFader label="A" value={volA} onChange={(v) => onVol('A', v)} min={0} max={1} step={0.01} />
        <SlideFader label="B" value={volB} onChange={(v) => onVol('B', v)} min={0} max={1} step={0.01} />
        {eqCol('B', eqB, filterB)}
      </div>

      {/* toggles */}
      <div className="shrink-0 flex items-center justify-center gap-1.5">
        <RoundToggle label="Qtz" icon={Magnet} on={quantize} onChange={setQuantize} box={24} />
        <RoundToggle label="Gain" icon={Gauge} on={autoGain} onChange={setAutoGain} box={24} />
        <RoundToggle label="Lim" icon={Shield} on={limiterOn} onChange={(v) => { setLimiterOn(v); djEngine.setLimiter(v); }} box={24} />
        <RoundToggle label="MIDI" icon={Piano} on={midiMapOn} onChange={onToggleMidiMap} box={24} />
      </div>

      {/* harmonic key match */}
      {camA && camB && (
        <div className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold border ${harmonic ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`} title={harmonic ? `Harmonic — ${camA.code} ↔ ${camB.code} mix in key` : `Key clash — ${camA.code} vs ${camB.code}`}>
          <Music2 className="w-2.5 h-2.5" />{harmonic ? 'In Key' : 'Clash'}
        </div>
      )}

      {/* crossfader */}
      <div className="shrink-0 w-full">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-black text-purple-300">A</span>
          <div className="flex-1"><SlideCrossfader value={crossfader} onChange={onCrossfade} ariaLabel="Crossfader" title="Crossfade A ↔ B (double-click to center)" /></div>
          <span className="text-[9px] font-black text-cyan-300">B</span>
        </div>
        <div className="text-center text-[8px] font-mono text-zinc-600 tabular-nums leading-tight mt-0.5">
          {crossfader < -0.05 ? `A ${Math.round(-crossfader * 100)}%` : crossfader > 0.05 ? `B ${Math.round(crossfader * 100)}%` : 'CENTER'}
        </div>
        <div className="flex justify-center mt-1">
          <button onClick={onToggleAutomix} title="Automix — auto-sequence + beatmatch-crossfade the active set"
            className={`px-3 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border transition-colors ${automixOn ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 animate-pulse' : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'}`}>
            {automixOn ? 'Automix ●' : 'Automix'}
          </button>
        </div>
      </div>
      {flash && <span className="shrink-0 text-center text-[8px] font-mono text-cyan-300 truncate w-full">{flash}</span>}
      {cueSupported && cueDevices.length > 0 && (
        <div className="shrink-0 flex items-center gap-1 w-full" title="Headphone (cue) output device">
          <Headphones className="w-2.5 h-2.5 text-zinc-500 shrink-0" />
          <select value={cueDev} onChange={(e) => { setCueDev(e.target.value); void djEngine.setCueSinkId(e.target.value); }}
            className="flex-1 min-w-0 bg-[#0e0c18] border border-white/10 text-zinc-300 text-[8px] font-mono px-1 py-0.5 rounded focus:outline-none" style={{ colorScheme: 'dark' }}>
            <option value="">Default out</option>
            {cueDevices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════ DeckRack (FX + STEMS, scaffold) ════════════ */

const DJ_FX: Array<{ key: djEngine.DjFx; label: string }> = [
  { key: 'flanger', label: 'Flng' }, { key: 'reverb', label: 'Verb' }, { key: 'wahwah', label: 'Wah' },
];
const STEM_LABEL: Record<string, string> = { vocals: 'Voc', drums: 'Drm', bass: 'Bass', other: 'Oth', guitar: 'Gtr', piano: 'Pno' };
const stemLabel = (n: string) => STEM_LABEL[n.toLowerCase()] ?? (n.charAt(0).toUpperCase() + n.slice(1, 4));

const DeckRack: React.FC<{ deck: 'A' | 'B'; accent: 'purple' | 'cyan'; entryId: string | null }> = ({ deck, accent, entryId }) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  // Per-deck FX wet amounts (0..1), wired live to the engine (D5). Lazy-builds
  // the deck's FX rack on first non-zero touch.
  const [fx, setFx] = useState<Record<string, number>>({ flanger: 0, reverb: 0, wahwah: 0 });
  const onFx = (k: djEngine.DjFx, v: number) => { setFx((p) => ({ ...p, [k]: v })); djEngine.setDeckFx(deck, k, v); };

  // Live stems (D4): load (separate if needed) cached stems, then per-stem faders.
  const [stemNames, setStemNames] = useState<string[]>(() => djEngine.getDeckStemNames(deck));
  const [stemLevels, setStemLevels] = useState<Record<string, number>>({});
  const [stemBusy, setStemBusy] = useState(false);
  const [stemMsg, setStemMsg] = useState<string | null>(null);
  // The engine clears stems on track change (loadDeck) — mirror that here.
  useEffect(() => { setStemNames(djEngine.getDeckStemNames(deck)); setStemMsg(null); }, [entryId, deck]);
  const loadStems = async () => {
    if (!entryId || stemBusy) return;
    setStemBusy(true); setStemMsg('checking…');
    try {
      const refs = await ensureStems(entryId, { stems: 4, quality: 'fast' }, (pct, phase) => setStemMsg(`${phase} ${pct}%`));
      if (!refs.length) { setStemMsg('no stems'); return; }
      setStemMsg('loading…');
      const names = await djEngine.loadDeckStems(deck, refs);
      setStemNames(names);
      setStemLevels(Object.fromEntries(names.map((n) => [n, 1])));
      setStemMsg(null);
    } catch (e) {
      setStemMsg(e instanceof Error ? e.message.slice(0, 24) : 'failed');
    } finally { setStemBusy(false); }
  };
  const onStem = (name: string, v: number) => { setStemLevels((p) => ({ ...p, [name]: v })); djEngine.setStemGain(deck, name, v); };

  return (
    <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <Layers className={`w-3 h-3 shrink-0 ${accentText}`} />
        <span className={`text-[9px] font-black uppercase tracking-wider ${accentText}`}>FX · Stems {deck}</span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col gap-1.5 p-1.5 overflow-hidden">
        {/* FX rack — live wet knobs (flanger / reverb / wah) */}
        <div className="grid grid-cols-3 gap-1 place-items-center">
          {DJ_FX.map(({ key, label }) => (
            <SlideKnob key={key} label={label} value={fx[key]} onChange={(v) => onFx(key, v)} min={0} max={1} step={0.01} size={30} centerReadout />
          ))}
        </div>
        {/* Live stems (D4) — per-stem gain faders, or a load/separate button */}
        <div className="mt-auto">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[7px] font-black uppercase tracking-widest text-zinc-500">Stems</span>
            {stemNames.length === 0 ? (
              <button onClick={() => void loadStems()} disabled={!entryId || stemBusy}
                className="ml-auto text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/20 disabled:opacity-30 disabled:pointer-events-none"
                title={entryId ? 'Separate this track into stems (cached if already done) → 4 live faders' : 'Load a track first'}>
                {stemBusy ? (stemMsg ?? 'working…') : 'Load'}
              </button>
            ) : stemMsg ? (
              <span className="ml-auto text-[7px] font-mono text-rose-300 truncate" title={stemMsg}>{stemMsg}</span>
            ) : null}
          </div>
          {stemNames.length > 0 ? (
            <div className="grid gap-1 place-items-center" style={{ gridTemplateColumns: `repeat(${Math.min(stemNames.length, 4)}, minmax(0,1fr))` }}>
              {stemNames.slice(0, 4).map((name) => (
                <SlideKnob key={name} label={stemLabel(name)} value={stemLevels[name] ?? 1} onChange={(v) => onStem(name, v)} min={0} max={1} step={0.01} size={28} centerReadout />
              ))}
            </div>
          ) : (
            stemBusy && <div className="text-[8px] font-mono text-zinc-600 truncate" title={stemMsg ?? ''}>{stemMsg ?? 'working…'}</div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════ TrackBrowser ═══════════════════════════════ */

const TrackBrowser: React.FC<{ source: Source; setSource: (s: Source) => void; onLoadDeck: (entryId: string, deck: djEngine.DeckId) => void }> = ({ source, setSource, onLoadDeck }) => {
  const entries = useLibraryStore((s) => s.entries);
  const analysisById = useDjAnalysisStore((s) => s.byId);
  const setlists = useSetlistStore((s) => s.setlists);
  const renameSetlist = useSetlistStore((s) => s.rename);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setEntries = useSetlistStore((s) => s.setEntries);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  const set = source.kind === 'set' ? setlists[source.id] ?? null : null;
  const isSet = source.kind === 'set' && !!set;

  // Rows: either library entries or a set's entries (resolved against the library for metadata).
  type Row = { entryId: string | null; title: string; bpm: number | null; key: string | null; dur: number | null; setIndex?: number };
  const baseRows: Row[] = isSet
    ? set!.entries.map((e, i) => {
        const lib = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
        const d = e.entryId ? analysisById[e.entryId]?.data ?? null : null;
        return { entryId: e.entryId, title: e.label, bpm: d?.bpm ?? null, key: d?.key ? keyLabel(d.key, d.scale) : null, dur: d?.duration_sec ?? lib?.duration ?? null, setIndex: i };
      })
    : entries.map((e) => {
        const d = analysisById[e.id]?.data ?? null;
        return { entryId: e.id, title: e.title, bpm: d?.bpm ?? null, key: d?.key ? keyLabel(d.key, d.scale) : null, dur: d?.duration_sec ?? e.duration ?? null };
      });
  const rows = q.trim() ? baseRows.filter((r) => r.title.toLowerCase().includes(q.trim().toLowerCase())) : baseRows;

  const commitRename = () => { if (set && editName.trim()) renameSetlist(set.id, editName.trim()); setEditing(false); };
  const reorder = (from: number, to: number) => {
    if (!set || to < 0 || to >= set.entries.length) return;
    const arr = [...set.entries];
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    setEntries(set.id, arr);
  };
  const removeEntry = (i: number) => { if (set) setEntries(set.id, set.entries.filter((_, idx) => idx !== i)); };
  const sendEntry = (e: SetlistEntry) => { const lib = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null; sendTrackToVj({ entryId: e.entryId, label: e.label, url: lib?.audioUrl ?? e.url, kind: e.kind ?? 'audio' }); };
  const sendWholeSet = () => {
    if (!set) return;
    const items: VjSetItem[] = set.entries.map((e) => { const lib = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null; return { entryId: e.entryId, label: e.label, url: lib?.audioUrl ?? e.url, kind: e.kind ?? 'audio' }; });
    sendSetToVj({ setId: set.id, name: set.name, items });
  };

  return (
    <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
      {/* header: source name + count + search + (set actions) */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        {isSet ? <ListMusic className="w-3.5 h-3.5 text-purple-400 shrink-0" /> : <LibraryIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
        {editing && set ? (
          <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }} onBlur={commitRename} className="bg-black/50 border border-purple-400/50 rounded px-1.5 py-0.5 text-[10px] text-zinc-100 focus:outline-none w-36" />
        ) : (
          <span className="text-[10px] font-black uppercase tracking-wider text-purple-300 truncate max-w-40" title={isSet ? set!.name : 'Library'}>{isSet ? set!.name : 'Library'}</span>
        )}
        <span className="text-[8px] font-mono text-zinc-600">{rows.length} {isSet ? 'tracks' : 'files'}</span>
        <div className="flex items-center gap-1 ml-auto bg-black/40 border border-white/10 rounded px-1.5 w-36 max-w-[40%]">
          <Search className="w-3 h-3 text-zinc-600 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" className="flex-1 min-w-0 bg-transparent text-[10px] font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600" />
        </div>
        {isSet && set && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => { setEditName(set.name); setEditing(true); }} className="p-0.5 text-zinc-500 hover:text-zinc-200" title="Rename set"><Pencil className="w-3 h-3" /></button>
            <button onClick={sendWholeSet} disabled={set.entries.length === 0} className="p-0.5 text-zinc-500 hover:text-cyan-300 disabled:opacity-30" title="Send whole set to VJ"><Cast className="w-3.5 h-3.5" /></button>
            <button onClick={() => { removeSetlist(set.id); setSource({ kind: 'library' }); }} className="p-0.5 text-zinc-500 hover:text-rose-400" title="Delete set"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>

      {/* column header */}
      <div className="shrink-0 grid items-center gap-1 px-2 py-0.5 border-b border-white/5 text-[7px] font-black uppercase tracking-wider text-zinc-600" style={{ gridTemplateColumns: '1.6rem minmax(0,1fr) 2.6rem 2.4rem 2.6rem 4.2rem' }}>
        <span className="text-right">#</span><span>Title</span><span className="text-right">BPM</span><span>Key</span><span className="text-right">Len</span><span className="text-right pr-1">Load</span>
      </div>

      {/* rows */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="h-full grid place-items-center text-[9px] font-mono text-zinc-600 px-3 text-center">
            {isSet ? 'Empty set — drag tracks here, or Save a loaded deck.' : (entries.length === 0 ? 'Library empty — generate or import audio.' : 'No matches.')}
          </div>
        ) : rows.map((r, i) => (
          <div key={(r.entryId ?? 'x') + i} draggable={!!r.entryId}
            onDragStart={(ev) => { if (!r.entryId) return; ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData(DJ_TRACK_MIME, r.entryId); ev.dataTransfer.setData('text/plain', r.title); }}
            className="grid items-center gap-1 px-2 py-0.5 text-[9px] font-mono text-zinc-400 hover:bg-white/5 border-b border-white/3 group/row cursor-grab active:cursor-grabbing"
            style={{ gridTemplateColumns: '1.6rem minmax(0,1fr) 2.6rem 2.4rem 2.6rem 4.2rem' }}>
            <span className="text-right text-zinc-600">{String(i + 1).padStart(2, '0')}</span>
            <span className="truncate text-zinc-300" title={r.title}>{r.title}</span>
            <span className="text-right tabular-nums text-zinc-500">{r.bpm != null ? r.bpm.toFixed(0) : '—'}</span>
            <span className="text-zinc-500">{r.key ?? '—'}</span>
            <span className="text-right tabular-nums text-zinc-600">{r.dur != null ? fmtTime(r.dur) : '—'}</span>
            <span className="flex items-center gap-0.5 justify-end pr-0.5">
              {isSet ? (
                <span className="hidden group-hover/row:flex items-center gap-0.5">
                  <button onClick={() => reorder(r.setIndex!, r.setIndex! - 1)} disabled={r.setIndex === 0} className="p-0.5 text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move up"><ChevronDown className="w-2.5 h-2.5 rotate-180" /></button>
                  <button onClick={() => reorder(r.setIndex!, r.setIndex! + 1)} className="p-0.5 text-zinc-600 hover:text-zinc-200" title="Move down"><ChevronDown className="w-2.5 h-2.5" /></button>
                  <button onClick={() => set && removeEntry(r.setIndex!)} className="p-0.5 text-zinc-600 hover:text-rose-400" title="Remove from set"><Trash2 className="w-2.5 h-2.5" /></button>
                </span>
              ) : null}
              <button onClick={() => r.entryId && onLoadDeck(r.entryId, 'A')} disabled={!r.entryId} className="px-1 py-0.5 rounded text-[8px] font-black text-purple-300 hover:bg-purple-500/20 disabled:opacity-30" title="Load onto Deck A">→A</button>
              <button onClick={() => r.entryId && onLoadDeck(r.entryId, 'B')} disabled={!r.entryId} className="px-1 py-0.5 rounded text-[8px] font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-30" title="Load onto Deck B">→B</button>
              {!isSet && r.entryId && <button onClick={() => sendEntry({ entryId: r.entryId, label: r.title, kind: 'audio' })} className="hidden group-hover/row:inline p-0.5 text-zinc-600 hover:text-cyan-300" title="Send to VJ"><Cast className="w-2.5 h-2.5" /></button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ═══════════════════════════════ SourceTree ═════════════════════════════════ */

/** Aspirational source tree (MIX.png). Local "Library" and the user's Sets are
 *  live; the rest are labelled placeholders for future streaming/import. */
const LOCAL_SOON = ['Musikk', 'Videoer', 'Skrivebord', 'Crates', 'iTunes · RekordBox'];
const ONLINE_SOON = ['iDJPool · VJPro', 'Digitrax Karaoke', 'Deezer · TIDAL', 'SoundCloud', 'Beatport · Beatsource'];

const SourceTree: React.FC<{ source: Source; setSource: (s: Source) => void; libCount: number }> = ({ source, setSource, libCount }) => {
  const setlists = useSetlistStore((s) => s.setlists);
  const createSetlist = useSetlistStore((s) => s.create);
  const setActive = useSetlistStore((s) => s.setActive);
  const sets = Object.values(setlists).sort((a, b) => b.updatedAt - a.updatedAt);

  // Online Download — same backend as the Media tab (/api/ytimport/fetch),
  // routed straight into the library so the imported track appears below.
  const [dlOpen, setDlOpen] = useState(false);
  const [dlUrl, setDlUrl] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState<string | null>(null);
  const runImport = async () => {
    const u = dlUrl.trim();
    if (!u || dlBusy) return;
    setDlBusy(true); setDlErr(null);
    try {
      await importUrlToLibrary(u);
      setDlUrl(''); setDlOpen(false);
      setSource({ kind: 'library' });
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : 'Import failed');
    } finally { setDlBusy(false); }
  };

  const Item: React.FC<{ active?: boolean; soon?: boolean; onClick?: () => void; children: React.ReactNode; right?: React.ReactNode; title?: string }> = ({ active, soon, onClick, children, right, title }) => (
    <button type="button" disabled={soon} onClick={onClick} title={title ?? (soon ? 'Source — coming soon' : undefined)}
      className={`w-full flex items-center gap-1.5 pl-4 pr-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${active ? 'bg-purple-500/15 text-purple-200' : soon ? 'text-zinc-700 cursor-default' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>
      <span className={`w-1 h-1 rounded-full shrink-0 ${active ? 'bg-purple-300' : 'bg-zinc-700'}`} />
      <span className="flex-1 truncate text-left">{children}</span>
      {right}
    </button>
  );
  const Group: React.FC<{ icon?: React.ReactNode; label: string; right?: React.ReactNode }> = ({ icon, label, right }) => (
    <div className="flex items-center gap-1 px-1 mt-1.5 mb-0.5 text-[8px] font-black uppercase tracking-widest text-zinc-500">
      <ChevronRight className="w-2.5 h-2.5" />{icon}{label}{right}
    </div>
  );

  return (
    <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <LibraryIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-wider text-purple-300 leading-tight">Source Tree</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        <Group label="Local Music" />
        <Item active={source.kind === 'library'} onClick={() => setSource({ kind: 'library' })} right={<span className="text-[8px] text-zinc-600">{libCount}</span>} title="Your generated + imported audio">Library</Item>
        {LOCAL_SOON.map((s) => <Item key={s} soon>{s}</Item>)}

        <Group label="Online Music" />
        <Item active={dlOpen} onClick={() => setDlOpen((v) => !v)} title="Download a track from a YouTube / SoundCloud / Bandcamp URL straight into your library">
          <span className="inline-flex items-center gap-1.5"><Download className="w-3 h-3" /> Online Download</span>
        </Item>
        {dlOpen && (
          <div className="px-2 py-1 flex flex-col gap-1">
            <div className="flex items-center gap-1 bg-black/40 border border-white/10 rounded px-1.5">
              <Link2 className="w-3 h-3 text-zinc-600 shrink-0" />
              <input value={dlUrl} onChange={(e) => setDlUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runImport(); }}
                placeholder="paste URL…" disabled={dlBusy} aria-label="Online import URL"
                className="flex-1 min-w-0 bg-transparent text-[9px] font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600 disabled:opacity-50" />
              <button onClick={() => void runImport()} disabled={dlBusy || !dlUrl.trim()} className="shrink-0 text-purple-300 hover:text-purple-100 disabled:opacity-30" title="Download into library">
                {dlBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              </button>
            </div>
            {dlErr && <span className="text-[8px] font-mono text-rose-400 px-1 truncate" title={dlErr}>{dlErr}</span>}
            <span className="text-[7px] font-mono text-zinc-600 px-1 leading-tight">YouTube · SoundCloud · Bandcamp — Spotify is DRM-locked</span>
          </div>
        )}
        {ONLINE_SOON.map((s) => <Item key={s} soon>{s}</Item>)}

        <Group label="Cache" />
        <Item soon>Offline Cache</Item>

        <Group label="Lists & Advice" right={<button onClick={() => { const id = createSetlist(`Set ${new Date().toLocaleDateString()}`); setActive(id); setSource({ kind: 'set', id }); }} className="ml-auto p-0.5 text-purple-300 hover:text-purple-100" title="New set"><Plus className="w-3 h-3" /></button>} />
        {sets.length === 0 ? (
          <div className="pl-4 pr-1.5 py-0.5 text-[9px] font-mono text-zinc-700">No sets — click +</div>
        ) : sets.map((s) => (
          <Item key={s.id} active={source.kind === 'set' && source.id === s.id} onClick={() => { setActive(s.id); setSource({ kind: 'set', id: s.id }); }} right={<span className="text-[8px] text-zinc-600">{s.entries.length}</span>} title={`Open set "${s.name}"`}>{s.name}</Item>
        ))}
      </div>
    </div>
  );
};

/* ═══════════════════════════════ DjMidiMap (D6) ═════════════════════════════ */

const DJ_MIDI_GROUPS = ['Mixer', 'Deck A', 'Deck B'];

/** Learn overlay: arm an action, move a control on your MIDI gear, it binds.
 *  Binding + dispatch run in DJView's one midiBus subscriber. */
const DjMidiMap: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const bindings = useDjControlMap((s) => s.bindings);
  const learnAction = useDjControlMap((s) => s.learnAction);
  const arm = useDjControlMap((s) => s.arm);
  const clear = useDjControlMap((s) => s.clear);
  const clearAll = useDjControlMap((s) => s.clearAll);
  return (
    <div className="fixed inset-0 z-200 grid place-items-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-115 max-h-[82%] overflow-y-auto rounded-lg border border-purple-500/30 bg-[#0c0a14] shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5 sticky top-0 bg-[#0c0a14]">
          <Piano className="w-3.5 h-3.5 text-purple-300 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 shrink-0">DJ MIDI Map</span>
          <span className="text-[8px] font-mono text-zinc-500 truncate">Click Learn, then move a control (MIDI must be ON)</span>
          <button onClick={clearAll} className="ml-auto shrink-0 text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-rose-300">Clear all</button>
          <button onClick={onClose} className="shrink-0 p-1 text-zinc-500 hover:text-white rounded hover:bg-white/5"><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="p-3 flex flex-col gap-2">
          {DJ_MIDI_GROUPS.map((g) => (
            <div key={g}>
              <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 mb-1">{g}</div>
              <div className="grid grid-cols-2 gap-1">
                {MIDI_ACTIONS.filter((a) => a.group === g).map((a) => {
                  const sig = bindings[a.id];
                  const learning = learnAction === a.id;
                  return (
                    <div key={a.id} className={`flex items-center gap-1 px-1.5 py-1 rounded border ${learning ? 'border-amber-400/60 bg-amber-500/10' : 'border-white/8 bg-black/30'}`}>
                      <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-300 truncate" title={a.label}>{a.label}</span>
                      <span className={`text-[8px] font-mono shrink-0 ${sig ? 'text-emerald-300' : 'text-zinc-600'}`}>{sigLabel(sig)}</span>
                      <button onClick={() => arm(learning ? null : a.id)} className={`shrink-0 text-[8px] font-bold uppercase px-1 py-0.5 rounded border ${learning ? 'border-amber-400 text-amber-300 animate-pulse' : 'border-white/10 text-zinc-400 hover:text-zinc-100'}`}>{learning ? '…' : 'Learn'}</button>
                      {sig && <button onClick={() => clear(a.id)} className="shrink-0 text-zinc-600 hover:text-rose-400" title="Clear binding"><X className="w-2.5 h-2.5" /></button>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------- helpers ----------------------------------- */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function snapToBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  for (const b of beats) { if (b <= t) best = b; else break; }
  return best;
}

function nearestBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  let bestD = Math.abs(t - best);
  for (const b of beats) { const d = Math.abs(t - b); if (d < bestD) { best = b; bestD = d; } if (b > t && d > bestD) break; }
  return best;
}

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

const DeckWaveform: React.FC<{ deckId: djEngine.DeckId; audioUrl: string; beats: number[] | null; cues: (number | null)[] | null; accent: 'purple' | 'cyan'; height?: number; }> = ({ deckId, audioUrl, beats, cues, accent, height = 48 }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const [loop, setLoop] = useState<{ in: number; out: number } | null>(null);

  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    const d = st.duration || 0;
    setDur((p) => (p === d ? p : d));
    if (playheadRef.current) playheadRef.current.style.left = d > 0 ? `${(st.currentTime / d) * 100}%` : '0%';
    const nl = st.loopActive && st.loopIn != null && st.loopOut != null ? { in: st.loopIn, out: st.loopOut } : null;
    setLoop((p) => (sameLoop(p, nl) ? p : nl));
  }), [deckId]);

  const beatMarks = useMemo(() => {
    if (!beats || beats.length === 0 || dur <= 0) return null;
    const dense = beats.length <= 400;
    const out: Array<{ left: number; down: boolean }> = [];
    for (let i = 0; i < beats.length; i++) { const down = i % 4 === 0; if (!dense && !down) continue; out.push({ left: (beats[i] / dur) * 100, down }); }
    return out;
  }, [beats, dur]);

  const accentColor = accent === 'purple' ? '#a855f7' : '#22d3ee';
  const scrubbing = useRef(false);
  const pendingX = useRef<number | null>(null);
  const scrubRaf = useRef(0);
  const seekToClientX = (clientX: number) => {
    const el = containerRef.current; if (!el) return;
    const d = djEngine.getStatus(deckId).duration; if (d <= 0) return;
    const rect = el.getBoundingClientRect();
    djEngine.seekDeck(deckId, clamp01((clientX - rect.left) / rect.width) * d);
  };
  const applyScrub = () => { scrubRaf.current = 0; const x = pendingX.current; pendingX.current = null; if (x != null) seekToClientX(x); };
  const queueScrub = (clientX: number) => { pendingX.current = clientX; if (!scrubRaf.current) scrubRaf.current = requestAnimationFrame(applyScrub); };
  const onScrubDown = (e: React.PointerEvent) => { if (djEngine.getStatus(deckId).duration <= 0) return; scrubbing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekToClientX(e.clientX); };
  const onScrubMove = (e: React.PointerEvent) => { if (scrubbing.current) queueScrub(e.clientX); };
  const onScrubUp = (e: React.PointerEvent) => { scrubbing.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };
  useEffect(() => () => { if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current); }, []);

  return (
    <div ref={containerRef} className="relative h-full" style={{ minHeight: height }}>
      <WaveformPreview audioUrl={audioUrl} height={height} interact={false} />
      <div className="absolute inset-0 z-10 cursor-ew-resize touch-none" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp} title="Drag to scrub · click to seek" />
      {beatMarks && (<div className="absolute inset-0 z-20 pointer-events-none">{beatMarks.map((m, i) => (<div key={i} className="absolute top-0 bottom-0" style={{ left: `${m.left}%`, width: '1px', background: m.down ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)' }} />))}</div>)}
      {loop && dur > 0 && (<div className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: `${(loop.in / dur) * 100}%`, width: `${((loop.out - loop.in) / dur) * 100}%`, background: 'rgba(245,200,66,0.18)', borderLeft: '1px solid rgba(245,200,66,0.7)', borderRight: '1px solid rgba(245,200,66,0.7)' }} />)}
      {dur > 0 && cues && cues.map((c, i) => (c == null ? null : (<div key={i} className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: `${(c / dur) * 100}%`, width: '2px', background: accentColor }}><span className="absolute top-0 left-0 text-[6px] font-black text-black px-0.5 leading-tight" style={{ background: accentColor }}>{i + 1}</span></div>)))}
      <div ref={playheadRef} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: '0%', width: '2px', background: '#ffffff', boxShadow: '0 0 4px rgba(255,255,255,0.8)' }} />
    </div>
  );
};
