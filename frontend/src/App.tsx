/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shell } from './components/layout/Shell';
import { useOnboardingStore, shouldAutoStart } from './onboarding/onboardingStore';
import { useHomeScreenStore } from './components/home/HomeScreen';
import { PlayerFooter } from './components/audio/PlayerFooter';
import { ParticleSplash } from './components/layout/ParticleSplash';
import { GantasmoOrb } from './orb-kit/react/GantasmoOrb';
// The assistant panel pulls in react-markdown + @google/genai; keep it out of
// the first-paint bundle by lazy-loading it and only mounting it once the user
// first opens the orb chat (see `assistantMounted` below).
const AssistantPanel = lazy(() => import('./orb-kit/AssistantPanel'));
// The orb's ferrofluid body pulls in three.js; keep it out of the first-paint
// bundle and only mount it once the backend is ready (the boot cinematic and
// splash own the GPU until then). The CSS gradient core renders meanwhile.
const FerroOrbCore = lazy(() => import('./components/audio/FerroOrbCore'));
import OrbDripTrail from './components/audio/OrbDripTrail';
import { OrbStatusFloat } from './components/audio/OrbStatusFloat';
import { useBottomPanelStore } from './state/bottomPanelStore';
import { useAssistantActivityStore } from './state/assistantActivityStore';
import { ASSISTANT_FOCUS_EVENT } from './state/assistantReferenceStore';
import { logInfo, logWarn, useLogStore, type LogLevel } from './state/logStore';
import { handletheDAWActionResult } from './orb-kit/actionHandlers';
import { useStatusBarStore } from './state/statusBarStore';
import { useLibraryStore } from './state/libraryStore';
import { useModuleStore } from './state/moduleStore';
import { useDownloadStore } from './state/downloadStore';
import { useLayoutPrefs } from './state/layoutPrefsStore';
import { startHeldNote, stopHeldNote, type HeldNote } from './lib/pianoTrigger';
import { createKeyboardMonitor, monitorVoice } from './lib/keyboardMonitor';
import { publishMidi, subscribeToMidi } from './state/midiBus';
import { isMidiMessageIgnored } from './state/midiIgnoreStore';
// Live MIDI capture (see the mount below). Every module here is already in this
// file's eager import graph via Shell/pianoTrigger EXCEPT `recordingStore`,
// which has to be loaded anyway for anything to record.
import { startMidiCapture } from './lib/midiCapture';
import { currentPassPunchWindow, useRecordingStore } from './state/recordingStore';
import { beginUndoStep, computePeaks, useEditorStore } from './state/editorStore';
import { currentTransportSec } from './state/liveMixer';
import { renderStepNotesToBlob } from './lib/midiSynth';
import { midiRenderSig } from './lib/midiRender';
import { withRenderTurn } from './state/midiRenderQueue';
import { configureAppMidiRenderQueue } from './state/appMidiRenderer';
import { ensureSoundfontReady, getActiveProgram, getGlobalVoice, isSoundfontActive } from './lib/soundfontEngine';
import { postStatus } from './state/statusNoticeStore';
import { startQuestMidi, stopQuestMidi } from './state/questMidiClient';
import { startXrControl, stopXrControl, registerXrControlSource } from './state/xrControlClient';
import { djControlSource } from './state/xrControlDjSource';
import { makeControlSource } from './state/makeControlSource';
import { processControlSource } from './state/processControlSource';
import { liveFxControlSource } from './state/liveFxControlSource';
import { transportControlSource } from './state/transportControlSource';
import { swayControlSource, startSwayXrMirror } from './state/swayControlSource';
import { startSwayBus } from './state/swayBus';
import { startSwayRouting } from './state/swayRouting';
import { startSwaySurface, swaySurfaceConsumes } from './state/swaySurface';
import { startSwayImportDriver } from './state/swayImportStore';
import { useSwaySurfaceStore } from './state/swaySurfaceStore';
import { poseControlSource, startPoseXrMirror } from './state/poseControlSource';
import { startPoseRouting } from './state/poseRouting';
import { startXrViz, stopXrViz } from './state/xrViz';
import { useMidiDevicesStore } from './state/midiDevicesStore';
import { isMidiAudioMuted, useMidiTriggerStore } from './state/midiTriggerStore';
import { midiInputConfig, startIoDevices, useIoDevicesStore } from './state/ioDevicesStore';
import { midiPortAllowed } from './lib/midiPortFilter';
import { setMidiOutputPorts } from './state/midiOutBus';
import { useFeatureToggleStore } from './state/featureToggleStore';
import { useGanStore } from './state/ganStore';
import { useProjectStore } from './state/projectStore';
import { useAppUiStore } from './state/appUiStore';
import { startRenderRunner } from './state/renderJobs';
import { requireFeature } from './notices/featureGateStore';
import { notifyPlacesChanged } from './lib/placesClient';

import './orb-kit/styles/gantasmo-orb.css';
import './orb-kit/chat/orb-chat.css';

// The MIDI render queue reads the app's own picker and live plan from the
// moment the app loads, so an assistant note edit made before EDIT was ever
// opened decides whether to render from what EDIT will play.
configureAppMidiRenderQueue();

export default function App() {
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  // Defer the assistant chunk (react-markdown + @google/genai) until the user
  // first opens the orb chat; once mounted it stays mounted so chat history
  // survives a close/reopen (the panel keeps its messages in local state).
  const [assistantMounted, setAssistantMounted] = useState(false);
  const [orbPosition, setOrbPosition] = useState(() => ({
    x: typeof window !== 'undefined' ? window.innerWidth - 80 : 900,
    y: 500,
  }));
  const [skipped, setSkipped] = useState(false);
  // The boot sequence (public/splash/index.html, hosted by ParticleSplash)
  // runs about 14 s: the particle face forms, becomes the wordmark, shows the
  // GANTASMO credit and spins out. The screen holds until the page reports
  // complete AND the backend is ready, so the sequence plays in full even when
  // the backend binds in under a second. A safety timeout guarantees handoff
  // if the page never reports (an asset that never loads), so the app can
  // never hang on the boot screen.
  // A `?nocinematic` query param (used by the screenshot/capture harness)
  // skips the wait on the sequence, so captures do not sit through it.
  const [cinematicDone, setCinematicDone] = useState(
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nocinematic'),
  );
  useEffect(() => {
    const t = setTimeout(() => setCinematicDone(true), 24000);
    return () => clearTimeout(t);
  }, []);

  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const assistantThinking = useAssistantActivityStore((s) => s.thinking);
  const refreshHealth  = useStatusBarStore((s) => s.refreshHealth);

  // Re-attach to downloads the backend is still tracking. The dock's state is
  // per page session but the backend's job registry is not, so without this a
  // reload orphans a failed download — along with the Retry button and token
  // field on its row, which are the only way to fix it.
  const rehydrateDownloads = useDownloadStore((s) => s.rehydrate);
  useEffect(() => {
    if (!isBackendReady) return;
    void rehydrateDownloads();
  }, [isBackendReady, rehydrateDownloads]);

  // Health polling lives here so it runs during the boot screen.
  // Brisk 400ms polling until the backend answers, then a 30s heartbeat.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 400;

    const poll = async () => {
      if (cancelled) return;
      await refreshHealth();
      if (cancelled) return;
      const ready = useStatusBarStore.getState().isBackendReady;
      // Until the backend answers, poll briskly: this is a loopback port that
      // is simply bound or not, and the old 1→2→4→8→16s backoff could leave the
      // boot screen up for another 16s after the backend was already serving.
      // Once ready, drop to a cheap steady heartbeat.
      retryDelay = ready ? 30000 : 400;
      timer = setTimeout(() => void poll(), retryDelay);
    };

    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshHealth]);

  // Stream backend log records into the LOG panel so VERBOSE mode shows real
  // backend activity (module, sidecar, warning, and error logs + tracebacks),
  // not only frontend events. Cursor-based; starts once the backend is up.
  useEffect(() => {
    if (!isBackendReady) return;
    let cancelled = false;
    let since = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/log?since=${since}`);
        if (res.ok) {
          const data = (await res.json()) as {
            seq: number;
            entries: Array<{ level: LogLevel; source: string; msg: string }>;
          };
          for (const e of data.entries) {
            useLogStore.getState().append(e.level, e.source, e.msg);
          }
          if (typeof data.seq === 'number') since = data.seq;
        }
      } catch {
        // backend momentarily unreachable; keep polling
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isBackendReady]);

  // Populate the library store the moment the backend port is bound — so the
  // right-side Library / DJ source panels are filled on startup, not only when
  // the Library tab is first opened. Idle-scheduled so it doesn't pile onto
  // first paint; load() is guarded by loaded/loading, so the Library tab
  // mounting later won't double-fetch.
  useEffect(() => {
    if (!isBackendReady) return;
    const lib = useLibraryStore.getState();
    if (lib.loaded || lib.loading) return;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => void useLibraryStore.getState().load(), { timeout: 1500 });
    else setTimeout(() => void useLibraryStore.getState().load(), 0);
  }, [isBackendReady]);

  // Preload the backend module catalog the moment the backend is ready, so the
  // Settings modal reads a cached list instead of fetching on open (which used
  // to fail transiently during a (re)start and look like all modules vanished).
  useEffect(() => {
    if (!isBackendReady) return;
    void useModuleStore.getState().load();
  }, [isBackendReady]);

  // Settle the projects folder once the backend first answers: a folder this
  // browser chose reaches the backend, or the backend's folder replaces it, so
  // asset installs and backups use the same folder from the start.
  const projectsDirSettled = useRef(false);
  useEffect(() => {
    if (!isBackendReady || projectsDirSettled.current) return;
    projectsDirSettled.current = true;
    void useProjectStore.getState().ensureDefaultDir();
  }, [isBackendReady]);

  // ONE device-change subscription for the whole app, plus the boot read of the
  // saved input/output choices. Idempotent — it only ever runs once. Waits for
  // the backend so the first /api/settings round trip lands rather than
  // failing and leaving every device on the system default.
  useEffect(() => {
    if (!isBackendReady) return;
    startIoDevices();
  }, [isBackendReady]);

  useEffect(() => {
    logInfo('system', 'theDAW UI initialized');
  }, []);

  // Mount the lazy assistant panel the first time it's opened, then leave it
  // mounted (its `isOpen` prop drives show/hide, so state is preserved).
  useEffect(() => {
    if (isAssistantOpen) setAssistantMounted(true);
  }, [isAssistantOpen]);

  // F17 — something somewhere added a reference chip and wants the composer.
  // Opening the panel is ALL this does: a reference is not a request, so no
  // message is ever sent, and an already-open panel is left exactly as it is
  // rather than being toggled shut by a second "Reference…" click.
  useEffect(() => {
    const onFocus = () => setIsAssistantOpen(true);
    window.addEventListener(ASSISTANT_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(ASSISTANT_FOCUS_EVENT, onFocus);
  }, []);

  // App-wide TEXT size: publish the persisted scale as the `--text-scale` CSS
  // variable. index.css multiplies every font-size utility by it (font-size
  // ONLY — layout, padding, icons, gaps are untouched). 1.0 = native (no
  // change). Clamped in the store so it can't reach an unusable extreme.
  const uiScale = useLayoutPrefs((s) => s.uiScale);
  useEffect(() => {
    // CHANGED: text-only — drop any legacy page-zoom and drive the font var.
    document.documentElement.style.removeProperty('zoom');
    document.documentElement.style.setProperty('--text-scale', String(uiScale));
  }, [uiScale]);

  // ── Global Web MIDI listener ───────────────────────────────────
  // Any connected MIDI controller is monitored through lib/keyboardMonitor:
  // each key sounds from its note-on to its note-off, held on while the
  // sustain pedal (CC64) is down, in the armed MIDI track's instrument (the
  // global picker's when none is armed). Velocity is preserved 0-127.
  // Hot-plug aware via MIDIAccess.onstatechange.
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  // Which ports are let through (Settings -> Inputs & outputs). Re-attaching on
  // a change is the whole point, so the effect depends on a stable key rather
  // than the object identity a settings refresh would churn.
  const midiInputKey = useFeatureToggleStore((s) => {
    const cfg = s.settings.io?.midi_inputs;
    const ports = Array.isArray(cfg?.ports) ? cfg.ports : [];
    return `${cfg?.mode ?? 'all'}:${ports.map((p) => p.id || p.label).join(',')}`;
  });
  useEffect(() => {
    // Gated behind the master MIDI toggle: until the user turns MIDI on
    // we never call requestMIDIAccess(), so Chrome's permission prompt +
    // Web MIDI deprecation notice only appear on explicit opt-in.
    if (!midiEnabled) {
      useMidiDevicesStore.getState().setMidiInputs([]);
      useIoDevicesStore.getState().setMidiPorts([]);
      setMidiOutputPorts([]);
      return;
    }
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return;
    let access: MIDIAccess | null = null;
    let cancelled = false;
    const monitor = createKeyboardMonitor({
      voice: () => {
        const ed = useEditorStore.getState();
        return monitorVoice(useRecordingStore.getState().armedTrackIds, ed.tracks, ed.clips, getGlobalVoice());
      },
      start: (key) => startHeldNote(key.note, key.velocity, key.voice),
      stop: (handle) => stopHeldNote(handle as HeldNote),
    });

    const onMidiMessage = (e: MIDIMessageEvent) => {
      if (!e.data) return;
      // 1. Republish on the global MIDI bus so every feature
      //    (VJView iframe forwarder, MidiMapper popups in Piano +
      //    Sequence) sees the same stream. Each subscriber decides
      //    what to do with it. ONE Web MIDI listener, many readers.
      publishMidi(e.data);

      // 2. The keyboard monitor. This reads raw `e.data` directly —
      //    it is NOT a bus subscriber, so publishMidi's own ignore
      //    filter (midiBus.ts) never sees it and the check has to be
      //    repeated here. A message the Sway surface consumes, or one
      //    on the DJ MIDI map's ignore list, never reaches it. A
      //    note-on is also skipped while the user has muted MIDI
      //    audio triggering (VJ performers who want the controller to
      //    drive effects only); note-offs and the pedal always pass,
      //    so a key held across the mute still releases. The bus
      //    publish above still runs (minus ignored controls), so
      //    visual effects keep reacting.
      const [status, , data2] = e.data;
      const command = status & 0xf0;
      const noteOn = command === 0x90 && data2 > 0;
      if (
        (command === 0x80 || command === 0x90 || command === 0xb0) &&
        !(noteOn && isMidiAudioMuted()) &&
        !swaySurfaceConsumes(e.data) &&
        !isMidiMessageIgnored(e.data)
      ) {
        try {
          monitor.message(e.data);
        } catch (err) {
          /* a single failed voice should not silence the whole bus */
          console.error('[midi] keyboard monitor failed:', err);
        }
      }
    };

    const attach = (a: MIDIAccess) => {
      const cfg = midiInputConfig();
      const names: string[] = [];
      const ports: Array<{ id: string; label: string }> = [];
      a.inputs.forEach((input) => {
        // Filter HERE, at the Web MIDI boundary, where the port id still
        // exists — never inside publishMidi, which also carries the Quest
        // bridge and the synthetic Sway surface and would silence both.
        input.onmidimessage = midiPortAllowed(input, cfg) ? onMidiMessage : null;
        names.push(input.name ?? 'unnamed');
        ports.push({ id: input.id, label: input.name ?? 'unnamed' });
      });
      // Publish the connected device names so the SLIDE/DJ controller pickers
      // can auto-detect a profile by name (and show what's plugged in).
      useMidiDevicesStore.getState().setMidiInputs(names);
      // And the {id,label} pairs for the I/O menu: names alone are not
      // identities (two identical controllers collide, and unplug/replug
      // reorders the list).
      const outs: Array<{ id: string; name: string; send: (data: number[]) => void }> = [];
      a.outputs.forEach((out) => {
        outs.push({ id: out.id, name: out.name ?? 'unnamed', send: (data) => out.send(data) });
      });
      setMidiOutputPorts(outs);
      useIoDevicesStore.getState().setMidiPorts(ports);
    };

    // Pass an explicit MIDIOptions ({ sysex: false }) — we don't need SysEx for
    // note/CC input. NOTE: Chrome still logs a platform DEPRECATION notice
    // ("Web MIDI will ask a permission to use even if the sysex is not
    // specified") — that's Chrome moving to always-prompt (milestone 82), not
    // something our call can suppress. Correct usage; the notice is unavoidable.
    (navigator as Navigator & { requestMIDIAccess: (opts?: { sysex?: boolean }) => Promise<MIDIAccess> })
      .requestMIDIAccess({ sysex: false })
      .then((a) => {
        if (cancelled) return;
        access = a;
        attach(a);
        const count = a.inputs.size;
        if (count > 0) {
          const names: string[] = [];
          a.inputs.forEach((i) => names.push(i.name ?? 'unnamed'));
          logInfo('midi', `Web MIDI ready — ${count} input${count === 1 ? '' : 's'}: ${names.join(', ')}`);
        } else {
          logInfo('midi', 'Web MIDI ready — no inputs connected');
        }
        a.onstatechange = () => {
          if (cancelled || !access) return;
          attach(access);
        };
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        logWarn('midi', `Web MIDI unavailable: ${e instanceof Error ? e.message : String(e)}`);
      });

    return () => {
      cancelled = true;
      // Keys held when MIDI is turned off or the ports change would get no note-off.
      monitor.panic();
      if (access) {
        access.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
        access.onstatechange = null;
      }
      setMidiOutputPorts([]);
      useIoDevicesStore.getState().setMidiPorts([]);
    };
  }, [midiEnabled, midiInputKey]);

  // ── Live MIDI capture ──────────────────────────────────────────
  // The bus above carries every inbound message; this is the one thing that
  // KEEPS one. A pass on an armed MIDI-instrument track becomes a piano-roll
  // clip at the transport second it was played at (lib/midiCapture).
  //
  // Mounted once, unconditionally, and deliberately NOT gated on `midiEnabled`:
  // that flag guards `requestMIDIAccess` only, while the bus also carries the
  // Quest bridge and the synthetic Sway surface — a pass played through either
  // is still a pass. Live monitoring (lib/keyboardMonitor, above) is
  // untouched: capture reads the bus, it does not consume it.
  useEffect(
    () =>
      startMidiCapture({
        subscribeMidi: subscribeToMidi,
        subscribeStatus: (cb) => useRecordingStore.subscribe(() => { cb(); }),
        status: () => useRecordingStore.getState().status,
        armedTrackIds: () => useRecordingStore.getState().armedTrackIds,
        tracks: () => useEditorStore.getState().tracks,
        clips: () => useEditorStore.getState().clips,
        transportSec: currentTransportSec,
        bpm: () => useEditorStore.getState().bpm,
        // THE window this pass was pressed with, straight off `recordingStore`
        // — not a restatement of its derivation. That store freezes the window
        // at the PRESS, and the capture opens on the flip into `recording`,
        // which for a pass with a count-in is a bar or more later: deriving it
        // again here would crop the notes to a window the take crop is not
        // using the moment the user touched the loop region during the count.
        punchWindow: currentPassPunchWindow,
        // The last term of lib/clipProgram's `effectiveProgramFor`, resolved the
        // same way its MIDI-insert path does: the picker's program only while
        // soundfonts are on.
        globalProgram: () => (isSoundfontActive() ? getActiveProgram() : undefined),
        ensureSoundfontReady,
        beginUndoStep,
        addClipToTrack: (clip) => useEditorStore.getState().addClipToTrack(clip),
        applyClipRender: (id, updates, peaks) => useEditorStore.getState().applyClipRender(id, updates, peaks),
        clipWindow: (id) => useEditorStore.getState().clips.find((c) => c.id === id),
        // A take's first render takes the MIDI render queue's turn, so it never
        // overlaps another render, and records what it was made from.
        renderStepNotes: (notes, bpm, totalSteps, opts) =>
          withRenderTurn('', 'MIDI take', () => renderStepNotesToBlob(notes, bpm, totalSteps, opts)),
        renderSig: midiRenderSig,
        computePeaks,
        postStatus,
      }),
    [],
  );

  // Auto-enable the Sway DAW-control mirror when the Audima Sway is the detected
  // controller — until the user manually toggles it, after which their choice
  // sticks (autoEnable is a no-op once touched).
  //
  // FE-025: controllerProfiles.ts is a 400+ line static table of every known
  // DJ/MIDI controller's control layout, only ever consulted here (once a MIDI
  // device is actually connected) — never during initial render. A DYNAMIC
  // import keeps it out of the first-paint bundle, the same pattern the render
  // runner below uses for WaveformEditor's runRenderJob.
  const midiInputNames = useMidiDevicesStore((s) => s.inputs);
  useEffect(() => {
    if (!midiInputNames.length) return;
    let cancelled = false;
    void import('./state/controllerProfiles')
      .then(({ detectProfileFromNames, AUDIMA_SWAY_ID }) => {
        if (cancelled) return;
        if (detectProfileFromNames(midiInputNames)?.id === AUDIMA_SWAY_ID) {
          useSwaySurfaceStore.getState().autoEnable();
        }
      })
      .catch((err: unknown) => {
        // A failed chunk fetch (stale build after a deploy, dev server gone)
        // must not fail silently: without this, connecting the Audima Sway
        // would just never auto-enable its mirror with no diagnostic at all.
        console.warn('[controllerProfiles] failed to load for Sway auto-detect:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [midiInputNames]);

  // Quest MIDI bridge (loopMIDI-free): when MIDI is on, open the WebSocket to
  // the backend `questmidi` module. It hosts the localhost TCP listener + adb
  // reverse and relays the headset's MIDI onto the same midiBus as hardware
  // controllers, so nothing else needs to change to react to the Quest.
  // XR control bus (spatialization P0/P1 + Foundry bindings): publish theDAW's
  // control manifest and apply inbound control-sets. UNCONDITIONAL — the bus is
  // a cheap local WebSocket and its consumers are not MIDI-specific: the
  // VST-Foundry builder binds canvas controls to these targets regardless of
  // whether a MIDI device is enabled. Registration is passive (sources
  // lazy-load their engines on first buildEntries/apply), so this adds nothing
  // to boot beyond the socket.
  useEffect(() => {
    // DJ source maps DJ_TARGETS to spatial controls with no per-control wiring.
    registerXrControlSource(djControlSource);
    // Sway (Audima): six expressive dimensions as named 0..1 signals.
    registerXrControlSource(swayControlSource);
    // Body-pose source (camera, forwarded from the VJ); pose values arrive via
    // poseBus regardless of MIDI.
    registerXrControlSource(poseControlSource);
    // MAKE (Magenta RT2): live generation params as bindable targets.
    registerXrControlSource(makeControlSource);
    // PROCESS (MIX effect chain): drive effect params on the next offline render.
    registerXrControlSource(processControlSource);
    // LIVE (master FX): always-available, non-destructive sound shaping on the
    // player output — the VST-Foundry demo-mode bind-test surface.
    registerXrControlSource(liveFxControlSource);
    // Transport: footer play/pause/seek/volume/loop for the phone companion
    // (Phase 3) and the headset (Phase 7 B1).
    registerXrControlSource(transportControlSource);
    startXrControl();
    return () => {
      stopXrControl();
    };
  }, []);

  // MIDI-specific bridges stay gated: Quest MIDI, the sway CC bus + mirrors,
  // pose mirror, and the XR visualization feed.
  useEffect(() => {
    if (!midiEnabled) return;
    startQuestMidi();
    const stopSway = startSwayBus();
    const stopSwayMirror = startSwayXrMirror();
    const stopSwayRoute = startSwayRouting();
    // Audima Sway DAW-control mirror: when its mode is on, the device's
    // faders/knobs/pads/play drive theDAW's mixer + transport + pads (the
    // handler no-ops while the mode is off, so it is safe to leave running).
    const stopSwaySurface = startSwaySurface();
    // Imported-project controller auto-attach: drive the imported tracks/effects
    // from the mappings the source DAW project defined (no-ops with no bindings).
    const stopSwayImport = startSwayImportDriver();
    // Body-pose source (camera, forwarded from the VJ). Publish its channels on
    // the same bus; the pose values themselves arrive via poseBus regardless of MIDI.
    registerXrControlSource(poseControlSource);
    const stopPoseMirror = startPoseXrMirror();
    // Stream the visualization feed (waveform pack) over the same bridge so a
    // theDAW-XR headset can render theDAW's live audio natively.
    startXrViz();
    return () => {
      stopQuestMidi();
      stopSway();
      stopSwayMirror();
      stopSwayRoute();
      stopSwaySurface();
      stopSwayImport();
      stopPoseMirror();
      stopXrViz();
    };
  }, [midiEnabled]);

  // Pose routing is camera-driven (forwarded from the VJ), independent of the
  // Web MIDI gate, so it runs for the app's lifetime.
  useEffect(() => {
    const stop = startPoseRouting();
    return stop;
  }, []);

  // ONE render runner for the whole app. The timeline's offline renders — the
  // master mixdown, the selection bounce, the master and per-track VST freezes —
  // are jobs on `state/renderJobs` now, and something has to drain that queue.
  // It cannot be EDIT: DAWCenterPanel unmounts the tab on every switch, and a
  // mixdown the user started must keep going while they go and look at MIX.
  // Starting it here also means a job left `running` by a reload is failed on
  // the next boot instead of wedging the queue forever (see startRenderRunner).
  //
  // `runRenderJob` is reached through a DYNAMIC import: a static one would pull
  // the whole EDIT chunk — wavesurfer, the effect stacks, the whole timeline —
  // into the first-paint bundle that the lazy() in DAWCenterPanel exists to keep
  // it out of. Nothing can enqueue a job without EDIT having been opened first,
  // so by the time this resolves the chunk is already in memory.
  useEffect(() => startRenderRunner({
    run: async (job, onProgress, isCancelled) => {
      let runRenderJob;
      try {
        ({ runRenderJob } = await import('./components/audio/WaveformEditor'));
      } catch (e) {
        // The chunk fetch itself failed — a stale build after a deploy, or the
        // dev server gone. `runRenderJob` never gets to raise its own notice, so
        // without this the job would land `failed` with a message nobody renders.
        const message = e instanceof Error ? e.message : String(e);
        requireFeature({
          id: 'render:runner-unavailable',
          kind: 'error',
          title: 'Render engine could not be loaded',
          message,
          autoDismissMs: 10000,
        });
        throw e;
      }
      return runRenderJob(job, onProgress, isCancelled);
    },
  }), []);

  // OS file associations (desktop): a double-clicked .tasmo / .gan is delivered
  // by the Electron main process; route it to the right opener and show MIX.
  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: { onOpenFile?: (cb: (filePath: string) => void) => () => void };
    }).electronAPI;
    if (!api?.onOpenFile) return;
    return api.onOpenFile((filePath) => {
      const lower = filePath.toLowerCase();
      if (lower.endsWith('.gan')) {
        void useGanStore.getState().openPath(filePath);
        useAppUiStore.getState().setCenterTab('mix');
      } else if (lower.endsWith('.tasmo')) {
        void useProjectStore.getState().loadPath(filePath);
        useAppUiStore.getState().setCenterTab('mix');
      }
    });
  }, []);

  // Desktop downloads: the Electron main process reports each finished download
  // with the path it was saved to. The path goes to the status bar and into
  // known places, so the next import control offers the file.
  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: {
        onDownloadDone?: (
          cb: (info: { path: string | null; filename: string; state: string }) => void,
        ) => () => void;
      };
    }).electronAPI;
    if (!api?.onDownloadDone) return;
    return api.onDownloadDone(({ path, filename, state }) => {
      if (state === 'completed' && path) {
        useStatusBarStore.getState().setText(`DOWNLOADED: ${path}`);
        logInfo('files', `Downloaded ${filename} to ${path}`);
        // The main process recorded the path before sending this event, so the
        // Recent menus that refetch now already see it.
        notifyPlacesChanged();
      } else {
        logWarn('files', `Download ${state}: ${filename}`);
      }
    });
  }, []);

  // See the note on <Shell /> below: hold the heavy app body back two frames so
  // the boot screen gets a paint before Shell's mount blocks the main thread.
  const [bodyMounted, setBodyMounted] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setBodyMounted(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  // The host hook for a DAW action. It dispatches through the RESULT form so
  // this log says what actually happened: the plain dispatcher answers with the
  // message alone, which used to let a miss read as "Executed action: X".
  // Awaited because the editor tools answer only once their audio re-render is
  // done — without the await this logs "[object Promise]". The result is
  // returned for hosts that read it; the assistant panel runs its own dispatch
  // (calling this prop for a result would execute every action twice).
  const handleAssistantAction = useCallback(async (action: { type: string; payload?: any }) => {
    const result = await handletheDAWActionResult(action);
    logInfo('assistant', `Action: ${action.type} → ${result.ok ? 'ok' : 'FAILED'}: ${result.message}`);
    return result;
  }, []);

  // The loading screen is gated purely on real backend readiness — it lifts the
  // instant the backend port is bound, never on a cosmetic timer. `skipped` is
  // the manual "continue without backend" escape (offered after a real wait).
  const showLoading = (!isBackendReady || !cinematicDone) && !skipped;

  // Once the boot intro lifts, decide the landing experience exactly once:
  // a genuine first run starts the feature tour (which spotlights the real UI,
  // so the HOME overlay stays down until it ends); returning users get the
  // HOME screen straight away when they've left "show at startup" on.
  const bootDone = !showLoading;

  // The boot layer is the #boot-splash node in index.html (the sequence's
  // iframe), not React's, so React lifts it here rather than by unmounting.
  useEffect(() => {
    if (!bootDone) return;
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.transition = 'opacity 0.4s ease';
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    const t = setTimeout(() => splash.remove(), 450);
    return () => clearTimeout(t);
  }, [bootDone]);
  const landingHandledRef = useRef(false);
  const firstRunTourRef = useRef(false);
  const tourActive = useOnboardingStore((s) => s.active);
  useEffect(() => {
    if (!bootDone || landingHandledRef.current) return;
    landingHandledRef.current = true;
    if (shouldAutoStart()) {
      firstRunTourRef.current = true;
      useOnboardingStore.getState().start();
    } else if (useHomeScreenStore.getState().showAtStartup) {
      useHomeScreenStore.getState().setOpen(true);
    }
  }, [bootDone]);
  // After the first-run tour is finished or skipped, surface HOME as the
  // landing (only for that first-run chain, never for a manually replayed tour).
  useEffect(() => {
    if (firstRunTourRef.current && !tourActive) {
      firstRunTourRef.current = false;
      if (useHomeScreenStore.getState().showAtStartup) {
        useHomeScreenStore.getState().setOpen(true);
      }
    }
  }, [tourActive]);

  return (
    <>
      {/* Main app always mounts so state initializes, but polls are gated on
          isBackendReady. Its FIRST mount is held back two frames: Shell pulls in
          DAWCenterPanel and with it every tab, and mounting that subtree blocks
          the main thread for seconds. Mounting it in the same commit as the boot
          screen meant the boot screen could not paint until the block was over —
          the app booted into a blank window instead of into the boot screen.
          Two frames is enough for the browser to present the boot screen first;
          nothing else about Shell's lifetime changes. */}
      {bodyMounted && <Shell />}
      <PlayerFooter />
      {/* The orb stays out of the boot cinematic entirely — mounting it only
          once the splash has lifted means it never flashes over the intro AND
          the cinematic keeps the GPU to itself. Because it first mounts after
          boot, its ferrofluid body is present from the very first frame the
          user sees it, so there is no CSS-gradient placeholder stage. */}
      {!showLoading && (
        <>
          <GantasmoOrb
            isActive={isAssistantOpen}
            onToggle={() => setIsAssistantOpen(prev => !prev)}
            onPositionChange={setOrbPosition}
            processing={assistantThinking}
            // Ferrofluid body (three.js, lazy) with the GANTASMO eyes + mouth
            // composited on top by the orb itself.
            coreOverlay={(
              <Suspense fallback={null}>
                <FerroOrbCore />
              </Suspense>
            )}
            // orb-2x is the 112px stack (30% down from the old 160). bounds must
            // match the CSS toggle size or viewport clamping drifts.
            className="orb-2x"
            bounds={112}
            // Pinned flush to the bottom-left corner (re-solved on every
            // resize, not draggable, any saved position ignored) with its drag
            // sign above it, until the user clicks it once: that click opens the
            // assistant and unpins it for good. defaultPosition is only the
            // fallback for an unpinned orb with no saved position.
            stickCorner="bottom-left"
            cornerMargin={0}
            defaultPosition={{ x: 12, y: typeof window !== 'undefined' ? window.innerHeight - 172 : 500 }}
            persistenceKey="thedaw-orb-pos-v4"
          />
          <OrbDripTrail position={orbPosition} orbBox={112} />
          {/* Status notices by the orb below 2xl, where the footer bubble is hidden. */}
          <OrbStatusFloat
            position={orbPosition}
            orbBox={112}
            onOpenLog={() => useBottomPanelStore.getState().setLogOpen(true)}
          />
        </>
      )}
      {assistantMounted && (
        <Suspense fallback={null}>
          <AssistantPanel
            isOpen={isAssistantOpen}
            onClose={() => setIsAssistantOpen(false)}
            onExecuteAction={handleAssistantAction}
            orbPosition={orbPosition}
          />
        </Suspense>
      )}

      {/* Loading screen overlays everything until backend is ready */}
      <AnimatePresence>
        {showLoading && (
          <motion.div
            key="loading"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="fixed inset-0 z-200"
            // Above #boot-splash, so the setup status and the escape hatch are
            // readable and clickable over the sequence.
            style={{ zIndex: 2147483001 }}
          >
            <ParticleSplash
              onSkip={() => setSkipped(true)}
              onComplete={() => setCinematicDone(true)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}


