/**
 * MidiPanel - the unified MIDI tab (merged Piano + Vocal).
 *
 * The shared Piano Roll is the surface; everything else feeds or operates on it.
 * Top to bottom:
 *   - the SETTINGS strip: the roll's transport, instrument, zoom and timing
 *     feel, the library song field with ANALYZE (LOAD / VALIDATE in its menu),
 *     a status readout, the note count and the MIDI mapper (MAP);
 *   - the body: the ACTION rail (REC, IMPORT, EXPORT, EDIT, AI, BEAT, ARP,
 *     VOICE, CLEAR), the roll grid (or the arpeggiator face), the vocal
 *     artifact rail when an artifact is loaded, and the Vocal2MIDI column when
 *     VOICE is on;
 *   - the SHAPE row (VirtuosoControls).
 * Vocal is one INPUT option: a live mic recording is converted to notes through
 * the SAME backend basic-pitch path as "Analyze" (far better than the live YIN),
 * and dropped into the roll without shrinking the grid (the take is highlighted).
 * A mic monitor runs while the tab is open so the input level is always visible
 * inside the REC key. No synthesis here.
 */

import { useMidiSongBoxRequest } from '../../state/midiSongBoxStore';
import {
  Activity,
  AudioLines,
  Brush,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Drum,
  FileCheck2,
  FolderOpen,
  Loader2,
  Mic,
  MicVocal,
  Search,
  Square,
  TrendingUp,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { DESKTOP_DROP_ORIGIN, LIBRARY_ID_MIME, dropHasLibraryOrFiles, entriesFromDrop } from '../../lib/libraryDrop';
import type { RenderNote } from '../../lib/midiSynth';
import { renderDrumBeatBlob, vocalizeEffect } from '../../lib/vocalBeat';
import {
  armInpaintGuide,
  downloadVocalMidi,
  fetchVocalArtifact,
  type ArtifactNote,
  type VocalArtifactDoc,
} from '../../lib/vocalExport';
import {
  startInputMonitor,
  type InputMonitor,
} from '../../lib/vocalToMidi';
import { IoSurfaceSelect } from '../audio/IoDeviceSelect';
import { useIoDevicesStore, useResolvedSurface } from '../../state/ioDevicesStore';
import { useLibraryStore } from '../../state/libraryStore';
import { isAudioEntry } from '../../state/libraryEntry';
import { logInfo, logWarn } from '../../state/logStore';
import { describeMicFailure, shouldAnnounceMicFailure } from '../../lib/micErrors';
import { activeTrackOf, rollTracksOf, usePianoRollStore, type PianoNote } from '../../state/pianoRollStore';
import { partComposeInstrument } from '../../lib/rollTracks';
import { artifactTake } from '../../lib/takeNotes';
import { importTake, placeTake } from '../../lib/rollTakes';
import { usePlayerStore } from '../../state/playerStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import {
  PianoRoll,
  PianoRollClearKey,
  PianoRollEditKey,
  PianoRollFeel,
  PianoRollMapKey,
  PianoRollBendKey,
  PianoRollTempoKey,
  PianoRollNoteCount,
  PianoRollTransport,
  PianoRollVoiceKey,
  PianoRollZoom,
  exportRollMidi,
  importMidiFileToRoll,
  importSheetFileToRoll,
  playedRollNotes,
} from '../audio/PianoRoll';
import { ArpeggiatorPanel } from '../audio/ArpeggiatorPanel';
import { VirtuosoControls } from '../audio/VirtuosoControls';
import { RollSnapControls } from '../audio/RollSnapControls';
import { Vocal2MidiPanel } from '../audio/vocal2midi/Vocal2MidiPanel';
import { AiComposePopover } from '../audio/AiComposePopover';
import { MidiImportPopover } from '../audio/MidiImportPopover';
import { importMidiFileAsTracks } from '../../lib/midiImportTracksApp';
import { InstrumentPicker } from '../audio/InstrumentPicker';
import {
  CORNER_CHEVRON_VIEWBOX,
  CORNER_GLYPH,
  CORNER_KEY,
  DockFlyout,
  FIELD,
  FLYOUT_CARD,
  CORNER_CLEAR_GLYPH,
  FLYOUT_SELECT,
  MenuKey,
  RAIL_GLYPH,
  RAIL_KEY_COMPACT_PX,
  RAIL_KEY_PX,
  RailKey,
  STRIP_GLYPH,
  Sep,
  StripKey,
  useDockTip,
  useEdgeTabClearance,
  useOrbClearance,
  useStoredToggle,
} from '../audio/midiDockKit';

/** The rail's "more keys this way" cue: a thin band over the rail's end. */
const RAIL_CUE =
  'absolute inset-x-0 z-20 h-3.5 flex items-center justify-center et-ink-2 hover:et-ink';

/**
 * One end's rail cue for a rail taller than the dock. Pointer only: keyboard
 * focus scrolls a key into view on its own, so the cue stays out of Tab. Its
 * word opens in a DockTip to its right, as the rail keys' do.
 */
const RailCue: React.FC<{ dir: 1 | -1; onGo: () => void; bottom?: number }> = ({ dir, onGo, bottom }) => {
  const name = dir === 1 ? 'Scroll down to more actions' : 'Scroll up to more actions';
  const { anchorRef, describedBy, tip } = useDockTip({ word: 'More actions', label: name, placement: 'right' });
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        tabIndex={-1}
        onClick={onGo}
        aria-label={name}
        aria-describedby={describedBy}
        className={`${RAIL_CUE} ${dir === 1 ? '' : 'top-0'}`}
        style={{
          ...(dir === 1 ? { bottom } : {}),
          background: `linear-gradient(to ${dir === 1 ? 'top' : 'bottom'}, var(--et-panel, #0c0a12) 45%, transparent)`,
        }}
      >
        {dir === 1 ? <ChevronDown aria-hidden="true" className="w-3 h-3" /> : <ChevronUp aria-hidden="true" className="w-3 h-3" />}
      </button>
      {tip}
    </>
  );
};

const stepSec = (bpm: number): number => 60 / bpm / 4;

/** Where the VOICE key remembers whether the Vocal2MIDI column is shown. */
const VOICE_COLUMN_KEY = 'thedaw-midi-voice-column-v1';

const pianoToArtifact = (notes: PianoNote[], bpm: number): ArtifactNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n) => ({
    start_ms: Math.round(n.step * ss * 1000),
    end_ms: Math.round((n.step + n.length) * ss * 1000),
    pitch: n.note,
    velocity: n.velocity,
  }));
};

const pianoToRender = (notes: PianoNote[], bpm: number): RenderNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n) => ({
    midi: n.note,
    startSec: n.step * ss,
    durationSec: Math.max(0.05, n.length * ss),
    velocity: n.velocity,
  }));
};

/**
 * The input level, drawn as a thin bar up the REC key's left edge while the
 * monitor is open. Runs its own rAF so the 60fps level updates never re-render
 * the parent panel (which embeds the Piano Roll). A sibling of the key, not a
 * child: a meter cannot live inside a button.
 */
const RecLevel: React.FC<{ monitorRef: React.MutableRefObject<InputMonitor | null>; recording: boolean }> = ({
  monitorRef,
  recording,
}) => {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setLevel(monitorRef.current?.getLevel() ?? 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [monitorRef]);
  const pct = Math.round(level * 100);
  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="pointer-events-none absolute left-0.5 top-1 bottom-1 w-0.5 rounded-full bg-black/50 overflow-hidden flex flex-col justify-end"
    >
      <div
        className={`w-full rounded-full ${recording ? 'bg-red-400' : 'bg-[rgb(var(--et-ink-2))]'}`}
        style={{ height: `${Math.max(level * 100, 4)}%` }}
      />
    </div>
  );
};

export const MidiPanel: React.FC = () => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const entries = useLibraryStore((s) => s.entries);
  const [assetId, setAssetId] = useState('');
  // What the search box shows (a friendly title); the actual API uses assetId.
  const [assetQuery, setAssetQuery] = useState('');
  const [assetOpen, setAssetOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('idle');
  // ANALYZE's per-second job message. Shown in the readout while it runs, but
  // kept out of the live region, which announces only `status`.
  const [progress, setProgress] = useState('');
  const [artifact, setArtifact] = useState<VocalArtifactDoc | null>(null);
  const [validateMsg, setValidateMsg] = useState('');
  const [arpOn, setArpOn] = useState(false);
  const [arpPlaying, setArpPlaying] = useState(false);
  const [voiceOn, setVoiceOn] = useStoredToggle(VOICE_COLUMN_KEY, true);
  // Step width is shared by the strip's zoom keys and the grid's ctrl+wheel.
  const [stepPx, setStepPx] = useState(16);
  /** The pitch bend lane under the grid; the strip's BEND key opens it. */
  const [showBend, setShowBend] = useState(false);
  /** The tempo lane under the grid; the strip's TEMPO key opens it. */
  const [showTempo, setShowTempo] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [inputMenuOpen, setInputMenuOpen] = useState(false);
  const [songMenuOpen, setSongMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const rollBpm = usePianoRollStore((s) => s.bpm);
  const rollMeterMap = usePianoRollStore((s) => s.meterMap);
  const rollPickup = usePianoRollStore((s) => s.pickupSteps);
  // The part AI COMPOSE writes into, and the instrument it can write for.
  const activePart = usePianoRollStore((s) => activeTrackOf(s));
  const composePart = React.useMemo(
    () => ({ name: activePart.name, instrument: partComposeInstrument(activePart) }),
    [activePart],
  );
  // The device comes from the global I/O menu (Settings -> Inputs & outputs),
  // with a per-surface override in the REC key's input menu. It used to be a
  // useState seeded from localStorage with NO try/catch — which threw during
  // render in a browser with site data blocked — and the SING pitch lane kept a
  // second, never-reconciled copy of the very same key.
  const deviceId = useResolvedSurface('midiVocal').deviceId;
  const micPerm = useIoDevicesStore((s) => s.micPermission);
  const monitorRef = useRef<InputMonitor | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStartRef = useRef(0);
  const recWrapRef = useRef<HTMLDivElement>(null);
  // The REC key's corner: its DockTip's anchor is also where the input card hands focus back.
  const recInputTip = useDockTip({
    word: 'Input',
    description: 'The microphone REC records from. Right-click REC opens it too.',
    label: 'Recording input device',
    expanded: inputMenuOpen,
    placement: 'right',
  });
  const songMenuKeyRef = useRef<HTMLButtonElement>(null);
  const exportKeyRef = useRef<HTMLButtonElement>(null);
  // The rail scrolls when the dock is short; the cues say which way more keys
  // are. The orb, parked on the bottom-left corner, can cover the rail's foot,
  // so the rail ends above it.
  const railRef = useRef<HTMLDivElement>(null);
  const railScrollRef = useRef<HTMLDivElement>(null);
  const railContentRef = useRef<HTMLDivElement>(null);
  const [railMore, setRailMore] = useState({ up: false, down: false });
  // Keys drop from RAIL_KEY_PX to RAIL_KEY_COMPACT_PX (28px to 21px; the gaps
  // to 1px, the end padding to none) only when that is what keeps the whole
  // rail in view without scrolling.
  const [railCompact, setRailCompact] = useState(false);
  const railOrb = useOrbClearance(railRef);
  // A dock taller than its default reaches up under the Shell's Library edge
  // tab; the strip and the body pad their right side clear of it.
  const stripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stripEdge = useEdgeTabClearance(stripRef);
  const bodyEdge = useEdgeTabClearance(bodyRef);

  useEffect(() => {
    const el = railScrollRef.current;
    if (!el) return;
    const update = () => {
      const content = railContentRef.current;
      if (content) {
        // Compact iff the full-height rail would not fit. The full height is
        // derived the same way in both states, so the switch cannot flap.
        // Keys in the flow only: the import key's screen-reader labels are
        // absolutely placed and take no height or gap.
        const keys = Array.from(content.children).filter((c) => {
          const el = c as HTMLElement;
          return el.offsetHeight > 0 && getComputedStyle(el).position !== 'absolute';
        }).length;
        // Per key the height difference, per gap 1px (2px to 1px), and the
        // content's 2px top and bottom padding, which compact drops.
        const saving = keys * (RAIL_KEY_PX - RAIL_KEY_COMPACT_PX) + Math.max(0, keys - 1) + 4;
        setRailCompact((wasCompact) => {
          const fullHeight = content.offsetHeight + (wasCompact ? saving : 0);
          return fullHeight > el.clientHeight + 1;
        });
      }
      const up = el.scrollTop > 1;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setRailMore((p) => (p.up === up && p.down === down ? p : { up, down }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (railContentRef.current) ro?.observe(railContentRef.current);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);

  const scrollRail = (dir: 1 | -1) => {
    const el = railScrollRef.current;
    if (el) el.scrollBy({ top: dir * Math.max(24, el.clientHeight - 28), behavior: 'smooth' });
  };

  // Default the asset field to the selected library item (override freely). Show
  // the friendly title in the box while keeping the real id for the API.
  useEffect(() => {
    if (selectedEntryId && !assetId) {
      setAssetId(selectedEntryId);
      const sel = useLibraryStore.getState().entries.find((e) => e.id === selectedEntryId);
      if (sel) setAssetQuery(sel.title);
    }
  }, [selectedEntryId, assetId]);

  // Pick a library entry into the asset field: store the real id, show the title.
  const pickAsset = useCallback((id: string, title: string) => {
    setAssetId(id);
    setAssetQuery(title);
    setAssetOpen(false);
  }, []);

  // A song sent from outside the dock (the footer track menu) replaces whatever
  // the box holds, and the Vocal2MIDI column that shows the box comes on. A
  // request made while the tab was closed is taken when the panel mounts.
  const songBoxRequest = useMidiSongBoxRequest((s) => s.pending);
  useEffect(() => {
    if (!songBoxRequest) return;
    useMidiSongBoxRequest.getState().consume();
    const requested = useLibraryStore.getState().entries.find((e) => e.id === songBoxRequest);
    pickAsset(songBoxRequest, requested?.title ?? songBoxRequest);
    setVoiceOn(true);
  }, [songBoxRequest, pickAsset, setVoiceOn]);

  // Library entries whose title matches the current search text (cap the list).
  const assetMatches = (() => {
    const q = assetQuery.trim().toLowerCase();
    const audio = entries.filter(isAudioEntry);
    const list = q ? audio.filter((e) => e.title.toLowerCase().includes(q)) : audio;
    return list.slice(0, 12);
  })();

  const refreshInputs = useCallback(async () => {
    await useIoDevicesStore.getState().refresh();
  }, []);

  // Always-on input monitor while the tab is open: opens the mic + an analyser so
  // the level is visible even when not recording. Re-opens when the device
  // changes; releases the mic when the tab unmounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const monitor = await startInputMonitor(deviceId || undefined);
        if (cancelled) {
          monitor.stop();
          return;
        }
        monitorRef.current = monitor;
        setMonitorOpen(true);
        void refreshInputs();
      } catch (e) {
        if (!cancelled) {
          // Re-enumerate first: a device that went away raises the "not
          // connected" notice from the store, in one place.
          void refreshInputs();
          // A machine with no microphone is not a fault, and this effect re-runs
          // on every device change and remount — so classify it, say it once,
          // and only call it a warning when something is actually wrong.
          const failure = describeMicFailure(e, 'the level meter');
          if (shouldAnnounceMicFailure(failure, 'the level meter')) {
            (failure.benign ? logInfo : logWarn)('vocal', failure.message);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        recorderRef.current?.stop();
      } catch {
        /* not recording */
      }
      recorderRef.current = null;
      monitorRef.current?.stop();
      monitorRef.current = null;
      setMonitorOpen(false);
    };
  }, [deviceId, refreshInputs]);

  const loadArtifact = useCallback(async (id: string) => {
    const doc = await fetchVocalArtifact(id);
    if (!doc) {
      setStatus('no artifact for asset (analyze it first)');
      return;
    }
    setArtifact(doc);
    // The roll takes the song's tempo with its fraction, and each note lands
    // at the tick it was sung on (lib/rollTakes).
    importTake(artifactTake(doc.notes), doc.timing?.tempo_bpm ?? 0, 'art');
    setStatus(`loaded ${doc.notes.length} notes`);
  }, []);

  // Record the mic, then convert through the backend basic-pitch path and place
  // the take in the roll WITHOUT shrinking the grid (it stays >= 256 steps).
  const toggleRecord = useCallback(() => {
    if (recording) {
      recorderRef.current?.stop(); // onstop does the conversion
      return;
    }
    const monitor = monitorRef.current;
    if (!monitor) {
      setStatus('no mic - check permission / input device');
      return;
    }
    try {
      const rec = new MediaRecorder(monitor.stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        setRecording(false);
        const elapsedSec = (performance.now() - recordStartRef.current) / 1000;
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        logInfo(
          'vocal',
          `recording stopped - ${(blob.size / 1024).toFixed(0)}KB, converting via basic-pitch`,
        );
        setBusy(true);
        setStatus('converting recording to notes...');
        try {
          const fd = new FormData();
          fd.append('file', blob, 'recording.webm');
          const res = await fetch('/api/vocal/audio-to-notes', { method: 'POST', body: fd });
          const data = await res.json();
          const notes: ArtifactNote[] = data.notes ?? [];
          // At the ticks basic-pitch heard each note on, never snapped to 16ths
          // (APPLY quantises), at the roll's own tempo (lib/rollTakes).
          const placed = placeTake(artifactTake(notes), elapsedSec, 'art');
          setStatus(`recorded ${placed} notes (${elapsedSec.toFixed(1)}s)`);
          logInfo('vocal', `recording -> ${placed} notes via basic-pitch`);
        } catch (e) {
          setStatus(`convert error: ${String(e)}`);
          logWarn('vocal', `audio-to-notes failed: ${String(e)}`);
        } finally {
          setBusy(false);
          recorderRef.current = null;
        }
      };
      recorderRef.current = rec;
      recordStartRef.current = performance.now();
      rec.start();
      setRecording(true);
      setStatus('recording - sing, then stop');
      const track = monitor.stream.getAudioTracks()[0];
      const st = track?.getSettings?.() ?? {};
      logInfo(
        'vocal',
        `recording from "${track?.label || 'default'}" ${st.sampleRate ?? '?'}Hz muted=${track?.muted}`,
      );
      window.setTimeout(() => {
        if (recorderRef.current && (monitorRef.current?.getLevel() ?? 0) < 0.02) {
          logWarn('vocal', 'no mic signal during recording (level ~0%) - wrong input or muted');
        }
      }, 1500);
    } catch (e) {
      setStatus(`record error: ${String(e)}`);
      logWarn('vocal', `record error: ${String(e)}`);
    }
  }, [recording]);

  const analyze = useCallback(async () => {
    if (!assetId) {
      setStatus('enter or select an asset id');
      return;
    }
    setBusy(true);
    setStatus('analyzing vocal...');
    try {
      const res = await fetch('/api/vocal/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId, transcribe: true }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`prepare ${res.status}: ${detail.slice(0, 200)}`);
      }
      const { job } = await res.json();
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const jr = await fetch(`/api/vocal/jobs/${job.id}`);
        const jd = await jr.json();
        setProgress(jd.message || jd.status);
        if (jd.status === 'done') {
          await loadArtifact(assetId);
          break;
        }
        if (jd.status === 'failed' || jd.status === 'cancelled') {
          setStatus(`analyze ${jd.status}: ${jd.error ?? ''}`);
          break;
        }
      }
    } catch (e) {
      setStatus(`analyze error: ${String(e)}`);
    } finally {
      setProgress('');
      setBusy(false);
    }
  }, [assetId, loadArtifact]);

  const exportMidi = useCallback(async () => {
    const roll = usePianoRollStore.getState();
    const { bpm, lanes, totalSteps, meterMap, pickupSteps } = roll;
    // Every part's notes: this writer has one channel, so the parts share it.
    const notes = rollTracksOf(roll).flatMap((t) => t.notes);
    if (!notes.length) {
      setStatus('no notes to export');
      return;
    }
    // downloadVocalMidi wraps the canonical RenderNote->SMF writer. Export exactly
    // what the roll plays (post-edit, lane repeats written out), not the stale
    // artifact, with the roll's meter at the ticks its bar starts land on.
    const played = playedRollNotes(notes, lanes, totalSteps);
    const result = await downloadVocalMidi(pianoToArtifact(played, bpm), 'midi', { meterMap, pickupSteps, bpm });
    if (result.path) setStatus(`exported ${played.length} notes to ${result.path}`);
    else if (result.downloaded) setStatus(`exported ${played.length} notes to .mid`);
    else if (result.cancelled) setStatus('export cancelled');
    else setStatus('export failed');
  }, []);

  const validate = useCallback(async () => {
    if (!assetId) return;
    // The strip's readout carries the result too: the artifact rail that shows
    // validateMsg exists only once an artifact is loaded.
    let msg: string;
    try {
      const r = await fetch(`/api/vocal/validate/${assetId}`);
      const d = await r.json();
      msg = d.ok
        ? `round-trip ${d.count_in} to ${d.count_out}, drift ${d.max_drift_ms}ms`
        : `validate: ${d.error}`;
    } catch (e) {
      msg = `validate error: ${String(e)}`;
    }
    setValidateMsg(msg);
    setStatus(msg);
  }, [assetId]);

  const makeBeat = useCallback(async () => {
    const { notes, bpm, lanes, totalSteps } = usePianoRollStore.getState();
    if (!notes.length) {
      setStatus('no notes for a beat');
      return;
    }
    // The beat renders once, so it gets the lane repeats written out.
    const render = pianoToRender(playedRollNotes(notes, lanes, totalSteps), bpm);
    setStatus('rendering beat...');
    try {
      const { blob } = await renderDrumBeatBlob(render);
      const span = Math.max(...render.map((r) => r.startSec)) + 0.5;
      const fx = vocalizeEffect(render, span);
      // The beat routes through the footer player so the global transport,
      // visualizer, and HUD own its playback instead of a detached element.
      const player = usePlayerStore.getState();
      await player.load(blob, { label: 'MIDI beat' });
      // The beat preview is a one-shot. load() applies the store's loop flag
      // (default true) and has no per-load override, so the visible footer loop
      // toggle is switched off before play; re-enabling it is one click.
      const { isLooping, toggleLoop } = usePlayerStore.getState();
      if (isLooping) toggleLoop();
      player.play();
      setStatus(`beat playing - fx idea: ${fx.effectId} (${fx.reason})`);
    } catch (e) {
      setStatus(`beat error: ${String(e)}`);
    }
  }, []);

  const inpaintSegment = useCallback(
    async (i: number) => {
      if (!artifact) return;
      const ok = await armInpaintGuide(artifact, i);
      setStatus(
        ok
          ? 'inpaint guide armed - open MAKE and Generate to re-sing the segment'
          : 'segment has no mask window (starts at 0)',
      );
    },
    [artifact],
  );

  const listOpen = assetOpen && assetMatches.length > 0;
  // MATCH reads a library song's rhythm analysis, so it gets the field's id only
  // when that id names an audio entry; typed text that matches none leaves it off.
  const songEntryId = entries.some((e) => isAudioEntry(e) && e.id === assetId) ? assetId : undefined;

  return (
    // data-keyscope: this tab and the EDIT timeline both bind Delete; see
    // lib/keyScope. The scope is the whole tab, so a hover over the strip, the
    // rail or the SHAPE row still hands Delete to the roll, as its old toolbar did.
    <div data-keyscope="piano-roll" className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      {/* ── SETTINGS strip ───────────────────────────────────────────────── */}
      <div
        ref={stripRef}
        className="shrink-0 h-8.5 flex flex-nowrap items-center gap-1 px-1.5 border-b border-white/8 bg-black/40"
        style={stripEdge ? { paddingRight: stripEdge } : undefined}
      >
        {/* The tab's one PLAY key: the roll, or the arpeggiator while its face is up. */}
        <PianoRollTransport arpShowing={arpOn} arpPlaying={arpPlaying} onArpPlayingChange={setArpPlaying} />
        <Sep />
        <InstrumentPicker compact />
        <PianoRollVoiceKey />
        <Sep />
        <PianoRollZoom stepPx={stepPx} onStepPxChange={setStepPx} />
        <PianoRollBendKey on={showBend} onChange={setShowBend} />
        <PianoRollTempoKey on={showTempo} onChange={setShowTempo} />
        <Sep />
        <RollSnapControls />
        <Sep />
        <PianoRollFeel />
        <Sep />

        {/* Analyze a library vocal into the roll — search by name, drop a
            library item here instead of pasting a raw id, or drop an audio
            file from the desktop (it imports to the library, then lands here). */}
        <div
          className={`${FIELD} relative w-44`}
          onDragOver={(e) => {
            if (dropHasLibraryOrFiles(e.dataTransfer)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            const dt = e.dataTransfer;
            if (!dropHasLibraryOrFiles(dt)) return;
            e.preventDefault();
            const id = dt.getData(LIBRARY_ID_MIME);
            // A desktop drop imports its first audio file, then picks it.
            void entriesFromDrop(dt, { entries: useLibraryStore.getState().entries, origin: DESKTOP_DROP_ORIGIN, max: 1 }).then(([first]) => {
              if (first) {
                pickAsset(first.id, first.title);
                if (!id) logInfo('vocal', `Imported "${first.title}" from the desktop into the song box`);
              } else if (id) {
                // An id the library does not know: keep the raw id, as before.
                pickAsset(id, id);
              }
            });
          }}
        >
          <Search aria-hidden="true" className={`${STRIP_GLYPH} shrink-0 et-ink-3`} />
          <label htmlFor="midi-asset-id" className="sr-only">
            Search library song
          </label>
          <input
            id="midi-asset-id"
            name="midi-asset-id"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="midi-asset-listbox"
            aria-expanded={listOpen}
            value={assetQuery}
            onChange={(e) => {
              setAssetQuery(e.target.value);
              setAssetId(e.target.value.trim());
              setAssetOpen(true);
            }}
            onFocus={() => setAssetOpen(true)}
            onBlur={() => window.setTimeout(() => setAssetOpen(false), 150)}
            placeholder="Song"
            title="Type a song name (or drop a library item or an audio file here). Pick a result to use it — no need to paste a raw id."
            className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-[12px] font-semibold et-ink"
          />
          {listOpen && (
            <div
              id="midi-asset-listbox"
              role="listbox"
              aria-label="Library songs"
              className={`absolute left-0 top-full mt-1 z-50 w-64 max-h-56 overflow-y-auto ${FLYOUT_CARD}`}
            >
              {assetMatches.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={e.id === assetId}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => pickAsset(e.id, e.title)}
                  className={`w-full text-left px-2 py-1.5 text-[12px] font-semibold border-b border-white/5 last:border-0 transition-shadow hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)] ${
                    e.id === assetId ? 'text-[rgb(var(--et-accent))]' : 'text-zinc-200'
                  }`}
                >
                  <span className="block truncate">{e.title}</span>
                  <span className="block truncate text-[12px] font-semibold et-ink-3">{e.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <StripKey
          onClick={() => void analyze()}
          unavailable={busy}
          description="Detect notes, pitch and lyrics from the library vocal (basic-pitch) and load them into the roll"
          icon={busy ? <Loader2 className={`${STRIP_GLYPH} animate-spin`} /> : <Activity className={STRIP_GLYPH} />}
          legend="Analyze"
        />
        <StripKey
          ref={songMenuKeyRef}
          iconOnly
          onClick={() => setSongMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={songMenuOpen}
          aria-controls="midi-song-menu"
          aria-label="More song actions"
          description="Load or validate the song's artifact"
          on={songMenuOpen}
          icon={<ChevronDown className={STRIP_GLYPH} />}
          legend="More"
        />
        <DockFlyout
          open={songMenuOpen}
          anchorRef={songMenuKeyRef}
          onClose={() => setSongMenuOpen(false)}
          placement="below"
          align="end"
          floorSelector="[data-dock-floor]"
          id="midi-song-menu"
          role="menu"
          aria-label="Song actions"
          className={`w-32 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
        >
          <MenuKey
            onClick={() => {
              setSongMenuOpen(false);
              if (assetId) void loadArtifact(assetId);
            }}
            disabled={busy || !assetId}
            title="Load an already-analyzed artifact's notes + lyrics into the roll without re-detecting"
            icon={<FolderOpen className="w-3 h-3" />}
            legend="Load"
          />
          <MenuKey
            onClick={() => {
              setSongMenuOpen(false);
              void validate();
            }}
            disabled={!assetId}
            title="Check the notes survive a notes -> MIDI -> notes round-trip and report any timing drift"
            icon={<FileCheck2 className="w-3 h-3" />}
            legend="Validate"
          />
        </DockFlyout>

        <div
          className="flex-1 min-w-0 px-1 text-right truncate text-[12px] font-semibold et-ink-3"
          title={progress || (status === 'idle' ? undefined : status)}
        >
          {progress && <span>{progress}</span>}
          <span role="status" className={progress ? 'sr-only' : undefined}>
            {status === 'idle' ? '' : status}
          </span>
        </div>
        <PianoRollNoteCount />
        <PianoRollMapKey />
      </div>

      {/* ── body: ACTION rail · roll (or arpeggiator) · artifact rail · Voice ─ */}
      <div ref={bodyRef} className="flex-1 min-h-0 flex" style={bodyEdge ? { paddingRight: bodyEdge } : undefined}>
        <div
          ref={railRef}
          role="group"
          aria-label="MIDI actions"
          className="relative w-9 shrink-0 flex flex-col border-r border-white/8 bg-black/40"
          style={railOrb.bottom ? { paddingBottom: railOrb.bottom } : undefined}
        >
          <div ref={railScrollRef} className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto no-scrollbar scroll-py-4">
            <div
              ref={railContentRef}
              data-compact={railCompact || undefined}
              className="group/rail flex flex-col gap-0.5 data-compact:gap-px p-0.5 data-compact:py-0"
            >
              {/* REC: the always-on monitor records; the corner opens the input. */}
              <div
                ref={recWrapRef}
                className="relative shrink-0"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setInputMenuOpen(true);
                }}
              >
                <RailKey
                  onClick={toggleRecord}
                  disabled={micPerm === 'denied'}
                  unavailable={busy}
                  rec={recording}
                  tipSuppressed={inputMenuOpen}
                  aria-label={recording ? 'Rec: stop recording' : 'Rec: record vocal to notes'}
                  description={
                    recording
                      ? 'Stop recording and convert the take to notes'
                      : micPerm === 'denied'
                        ? 'Microphone blocked: allow it for this app, then choose the input from the corner menu'
                        : 'Record the mic and convert it to notes with basic-pitch. Right-click or the corner for the input device.'
                  }
                  icon={recording ? <Square className={`${RAIL_GLYPH} ${CORNER_CLEAR_GLYPH}`} /> : <Mic className={`${RAIL_GLYPH} ${CORNER_CLEAR_GLYPH}`} />}
                  legend="Rec"
                />
                {monitorOpen && <RecLevel monitorRef={monitorRef} recording={recording} />}
                <button
                  ref={recInputTip.anchorRef}
                  type="button"
                  onClick={() => setInputMenuOpen((v) => !v)}
                  aria-haspopup="dialog"
                  aria-expanded={inputMenuOpen}
                  aria-controls="midi-rec-input"
                  aria-label="Recording input device"
                  aria-describedby={recInputTip.describedBy}
                  className={CORNER_KEY}
                >
                  <ChevronRight aria-hidden="true" className={CORNER_GLYPH} viewBox={CORNER_CHEVRON_VIEWBOX} strokeWidth={3} />
                </button>
                {recInputTip.tip}
              </div>
              <DockFlyout
                open={inputMenuOpen}
                anchorRef={recWrapRef}
                returnFocusRef={recInputTip.anchorRef}
                onClose={() => setInputMenuOpen(false)}
                placement="right"
                floorSelector="[data-dock-floor]"
                id="midi-rec-input"
                role="dialog"
                aria-label="Microphone input"
                className={`w-64 p-2 flex flex-col items-start gap-1.5 ${FLYOUT_CARD}`}
              >
                {/* Vocal input — an override of the global microphone (Settings).
                    One printed word; the select's accessible name stays full. */}
                <IoSurfaceSelect
                  surface="midiVocal"
                  id="midi-input-device"
                  label="Microphone input"
                  legend="Input"
                  showLabel
                  labelClassName="text-[12px] font-display font-bold uppercase et-ink-3"
                  selectClassName={FLYOUT_SELECT}
                  hintClassName="text-[12px] font-semibold"
                />
                {micPerm === 'denied' && (
                  <span className="text-[12px] font-semibold text-red-300">mic blocked</span>
                )}
              </DockFlyout>

              <MidiImportPopover
                onImportFile={importMidiFileToRoll}
                onImportSheetFile={importSheetFileToRoll}
                onImportTracksFile={importMidiFileAsTracks}
              />

              <RailKey
                ref={exportKeyRef}
                onClick={() => setExportMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                aria-controls="midi-export-menu"
                aria-label="Export MIDI"
                description="Save the roll as a Standard MIDI (.mid) file"
                on={exportMenuOpen}
                icon={<Download className={RAIL_GLYPH} />}
                legend="Export"
              />
              <DockFlyout
                open={exportMenuOpen}
                anchorRef={exportKeyRef}
                onClose={() => setExportMenuOpen(false)}
                placement="right"
                floorSelector="[data-dock-floor]"
                id="midi-export-menu"
                role="menu"
                aria-label="Export MIDI"
                className={`w-28 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
              >
                <MenuKey
                  onClick={() => {
                    setExportMenuOpen(false);
                    void exportRollMidi();
                  }}
                  title="The roll at its own BPM, one track named Piano Roll (piano-roll.mid)"
                  icon={<Download className="w-3 h-3" />}
                  legend="Roll"
                />
                <MenuKey
                  onClick={() => {
                    setExportMenuOpen(false);
                    void exportMidi();
                  }}
                  title="Through the vocal export writer: the same notes, seconds-exact (midi.mid); the status line reports it"
                  icon={<Download className="w-3 h-3" />}
                  legend="Vocal"
                />
              </DockFlyout>

              <PianoRollEditKey />

              <AiComposePopover
                currentBpm={rollBpm}
                meterMap={rollMeterMap}
                pickupSteps={rollPickup}
                part={composePart}
                // The part comes back in the meter it was asked for, whatever the roll holds by then.
                onGenerated={(result) =>
                  usePianoRollStore.getState().importNotes(result.notes, result.bpm, { meterMap: result.meterMap, pickupSteps: result.pickupSteps })
                }
              />

              <RailKey
                onClick={() => void makeBeat()}
                aria-label="Beat from the notes"
                description="Render a General MIDI drum beat from the notes (low, mid and high to kick, snare and hat) and play it"
                icon={<Drum className={RAIL_GLYPH} />}
                legend="Beat"
              />
              <RailKey
                onClick={() => setArpOn((v) => !v)}
                aria-pressed={arpOn}
                aria-label="Arp: chord-progression arpeggiator"
                description={arpOn ? 'Back to the piano roll' : 'Show the chord-progression arpeggiator'}
                on={arpOn}
                icon={<TrendingUp className={RAIL_GLYPH} />}
                legend="Arp"
              />
              <RailKey
                onClick={() => setVoiceOn(!voiceOn)}
                aria-pressed={voiceOn}
                aria-label="Voice: the Vocal2MIDI column"
                description={voiceOn ? 'Hide the Vocal2MIDI column' : 'Show the Vocal2MIDI column'}
                on={voiceOn}
                icon={<AudioLines className={RAIL_GLYPH} />}
                legend="Voice"
              />
              <PianoRollClearKey />
            </div>
          </div>
          {/* Pointer cues for a rail taller than the dock (RailCue). */}
          {railMore.up && <RailCue dir={-1} onGo={() => scrollRail(-1)} />}
          {railMore.down && <RailCue dir={1} onGo={() => scrollRail(1)} bottom={railOrb.bottom} />}
        </div>

        {/* The arpeggiator stays mounted but hidden so its transport keeps
            running when toggling back to the roll. */}
        <div className="flex-1 min-w-0 relative">
          <div className={arpOn ? 'hidden' : 'absolute inset-0'}>
            <PianoRoll stepPx={stepPx} onStepPxChange={setStepPx} showBend={showBend} showTempo={showTempo} />
          </div>
          <div className={arpOn ? 'absolute inset-0' : 'hidden'}>
            <ArpeggiatorPanel playing={arpPlaying} />
          </div>
        </div>

        {!arpOn && artifact && (
          // data-dock-aside: a dock card opened from the strip (MAP) keeps off this rail.
          <div data-dock-aside="" className="w-64 shrink-0 border-l border-white/8 overflow-y-auto p-2 space-y-3">
            <section>
              <h3 className="text-[12px] font-display font-bold uppercase et-ink-3 mb-1">
                Lyrics
              </h3>
              <p className="text-[12px] font-semibold text-zinc-300 whitespace-pre-wrap wrap-break-word">
                {artifact.lyrics?.text || (
                  <span className="et-ink-3">none (analyze with transcription)</span>
                )}
              </p>
              <StripKey
                onClick={() => useBottomPanelStore.getState().showTab('sing')}
                aria-label="Sing: open the lyrics in the SING tab"
                description="Sing along, edit or time the lyrics in the SING tab"
                icon={<MicVocal className={STRIP_GLYPH} />}
                legend="Sing"
                className="mt-1"
              />
            </section>

            <section>
              <h3 className="text-[12px] font-display font-bold uppercase et-ink-3 mb-1">
                Segments
              </h3>
              {artifact.segments?.length ? (
                <ul className="space-y-1">
                  {artifact.segments.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-zinc-400 tabular-nums">
                        {(s.start_ms / 1000).toFixed(2)}-{(s.end_ms / 1000).toFixed(2)}s {s.kind}
                      </span>
                      <StripKey
                        onClick={() => void inpaintSegment(i)}
                        aria-label={`Inpaint segment ${i + 1}`}
                        description="Arm an inpaint guide for this segment"
                        icon={<Brush className={STRIP_GLYPH} />}
                        legend="Inpaint"
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] font-semibold et-ink-3">none</p>
              )}
            </section>

            {validateMsg && (
              <p className="text-[12px] font-semibold text-zinc-400 wrap-break-word">{validateMsg}</p>
            )}
          </div>
        )}

        {/* Vocal2MIDI suite — the full vocal-to-MIDI tool as a collapsible right
            column, shown while VOICE is on. Its recorder/AI/editor write notes
            into the piano roll. */}
        {!arpOn && voiceOn && <Vocal2MidiPanel />}
      </div>

      {/* ── SHAPE row ────────────────────────────────────────────────────── */}
      <VirtuosoControls songEntryId={songEntryId} onStatus={setStatus} />
    </div>
  );
};
