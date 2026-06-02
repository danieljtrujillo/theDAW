/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shell } from './components/layout/Shell';
import { PlayerFooter } from './components/audio/PlayerFooter';
import { LoadingScreen } from './components/layout/LoadingScreen';
import { GantasmoOrb } from './orb-kit/react/GantasmoOrb';
import { AssistantPanel } from './orb-kit/AssistantPanel';
import { logInfo, logWarn } from './state/logStore';
import { handletheDAWAction } from './orb-kit/actionHandlers';
import { useStatusBarStore } from './state/statusBarStore';
import { triggerPianoNoteFromMidi } from './components/audio/PianoRoll';
import { publishMidi } from './state/midiBus';
import { useMidiDevicesStore } from './state/midiDevicesStore';
import { isMidiAudioMuted, useMidiTriggerStore } from './state/midiTriggerStore';

import './orb-kit/styles/gantasmo-orb.css';
import './orb-kit/chat/orb-chat.css';

export default function App() {
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [orbPosition, setOrbPosition] = useState(() => ({
    x: typeof window !== 'undefined' ? window.innerWidth - 80 : 900,
    y: 500,
  }));
  const [skipped, setSkipped] = useState(false);
  const [minWaitOver, setMinWaitOver] = useState(false);

  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const refreshHealth  = useStatusBarStore((s) => s.refreshHealth);

  // Enforce a minimum 7-second loading screen
  useEffect(() => {
    const t = setTimeout(() => setMinWaitOver(true), 7000);
    return () => clearTimeout(t);
  }, []);

  // Health polling lives here so it runs during the loading screen.
  // Exponential backoff: 1s → 2s → 4s → 8s → 16s until ready, then 30s steady.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;

    const poll = async () => {
      if (cancelled) return;
      await refreshHealth();
      if (cancelled) return;
      const ready = useStatusBarStore.getState().isBackendReady;
      retryDelay = ready ? 30000 : Math.min(retryDelay * 2, 16000);
      timer = setTimeout(() => void poll(), retryDelay);
    };

    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshHealth]);

  useEffect(() => {
    logInfo('system', 'theDAW UI initialized');
  }, []);

  // ── Global Web MIDI listener ───────────────────────────────────
  // Any connected MIDI controller's note-on messages trigger the
  // synthesizer voice exposed by PianoRoll (triggerPianoNoteFromMidi).
  // Velocity is preserved 0-127. note-off events stop nothing —
  // the synth voice has its own envelope that naturally decays.
  // Hot-plug aware via MIDIAccess.onstatechange.
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  useEffect(() => {
    // Gated behind the master MIDI toggle: until the user turns MIDI on
    // we never call requestMIDIAccess(), so Chrome's permission prompt +
    // Web MIDI deprecation notice only appear on explicit opt-in.
    if (!midiEnabled) {
      useMidiDevicesStore.getState().setMidiInputs([]);
      return;
    }
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return;
    let access: MIDIAccess | null = null;
    let cancelled = false;

    const onMidiMessage = (e: MIDIMessageEvent) => {
      if (!e.data) return;
      // 1. Republish on the global MIDI bus so every feature
      //    (VJView iframe forwarder, MidiMapper popups in Piano +
      //    Sequence) sees the same stream. Each subscriber decides
      //    what to do with it. ONE Web MIDI listener, many readers.
      publishMidi(e.data);

      // 2. Built-in piano-synth trigger on note-on. Skipped when the
      //    user has muted MIDI audio triggering (VJ performers who
      //    want the controller to drive effects only). The bus
      //    publish above still runs, so visual effects keep reacting.
      const [status, data1, data2] = e.data;
      const command = status & 0xf0;
      if (command === 0x90 && data2 > 0 && !isMidiAudioMuted()) {
        try {
          triggerPianoNoteFromMidi(data1, data2);
        } catch (err) {
          /* a single failed voice should not silence the whole bus */
          console.error('[midi] note trigger failed:', err);
        }
      }
    };

    const attach = (a: MIDIAccess) => {
      const names: string[] = [];
      a.inputs.forEach((input) => {
        input.onmidimessage = onMidiMessage;
        names.push(input.name ?? 'unnamed');
      });
      // Publish the connected device names so the SLIDE/DJ controller pickers
      // can auto-detect a profile by name (and show what's plugged in).
      useMidiDevicesStore.getState().setMidiInputs(names);
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
      if (access) {
        access.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
        access.onstatechange = null;
      }
    };
  }, [midiEnabled]);

  const handleAssistantAction = useCallback((action: { type: string; payload?: any }) => {
    const result = handletheDAWAction(action);
    logInfo('assistant', `Action: ${action.type} → ${result}`);
  }, []);

  const showLoading = (!isBackendReady || !minWaitOver) && !skipped;

  return (
    <>
      {/* Main app always mounts so state initializes, but polls are gated on isBackendReady */}
      <Shell />
      <PlayerFooter />
      <GantasmoOrb
        isActive={isAssistantOpen}
        onToggle={() => setIsAssistantOpen(prev => !prev)}
        onPositionChange={setOrbPosition}
      />
      <AssistantPanel
        isOpen={isAssistantOpen}
        onClose={() => setIsAssistantOpen(false)}
        onExecuteAction={handleAssistantAction}
        orbPosition={orbPosition}
      />

      {/* Loading screen overlays everything until backend is ready */}
      <AnimatePresence>
        {showLoading && (
          <motion.div
            key="loading"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="fixed inset-0 z-200"
          >
            <LoadingScreen onSkip={() => setSkipped(true)} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}


