/**
 * Settings → Inputs & outputs.
 *
 * Six global device slots, then a collapsed disclosure holding the fine-grained
 * half: one row per surface that can be pointed somewhere else. Every override
 * row's first option reads "Default (<the device the global slot resolves to
 * right now>)", so a user with several interfaces can see what they are
 * overriding before they override it.
 *
 * What is deliberately NOT a control here is as important as what is. A slot
 * that cannot be wired end to end gets a sentence, not a dead dropdown: the VJ
 * camera list lives on the VJ's own origin, the assistant's speech API has no
 * device parameter, and the embedded panels that make sound in their own
 * windows cannot be routed from here at all.
 */
import React, { useState } from 'react';
import { AlertTriangle, Headphones, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { IoGlobalSelect, IoSurfaceSelect } from '../../audio/IoDeviceSelect';
import { describeMidiInputs, toggleMidiPort } from '../../../lib/midiPortFilter';
import {
  midiInputConfig,
  resolveGlobal,
  setMidiInputSelection,
  useIoDevicesStore,
} from '../../../state/ioDevicesStore';
import { IO_SURFACES } from '../../../state/ioSurfaces';
import { useFeatureToggleStore } from '../../../state/featureToggleStore';
import { getEngineOutputInfo } from '../../../state/playerStore';
import { BODY, BTN_GHOST, CARD, SECTION_META, SectionHeader, Segmented } from './shared';

const ROW = 'flex flex-wrap items-center gap-1.5 px-1.5 py-1 border-b border-white/5 last:border-b-0';
const ROW_LABEL = 'text-[11px] font-mono uppercase tracking-wider text-zinc-300 w-28 shrink-0';
const META = 'text-[11px] font-mono text-zinc-500';
const NOTE = 'text-[11px] text-zinc-500 px-1.5 py-1';

export const IoSection: React.FC = () => {
  const supports = useIoDevicesStore((s) => s.supports);
  const micPermission = useIoDevicesStore((s) => s.micPermission);
  const labelsKnown = useIoDevicesStore((s) => s.labelsKnown);
  const midiIn = useIoDevicesStore((s) => s.midiIn);
  const refresh = useIoDevicesStore((s) => s.refresh);
  const refreshDisplays = useIoDevicesStore((s) => s.refreshDisplays);
  const io = useFeatureToggleStore((s) => s.settings.io);
  const [open, setOpen] = useState(false);

  const main = resolveGlobal('audio_output');
  const cue = resolveGlobal('cue_output');
  const midiCfg = midiInputConfig();
  const engine = getEngineOutputInfo();
  // Subscribing to `io` is what re-renders this whole section when a choice
  // lands (the selects read the resolved values through their own hooks).
  const overrideCount = IO_SURFACES.filter((s) => io?.overrides?.[s.id] !== undefined).length;

  // Pre-listening into the same device you are mixing on defeats the point, but
  // it is a legitimate thing to do while there is only one output — so it is a
  // warning, not a block.
  const cueClashes = !!cue.deviceId && cue.deviceId === main.deviceId;

  return (
    <div>
      <SectionHeader
        icon={<SlidersHorizontal className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
        title="Inputs & outputs"
        tip="Pick the devices theDAW plays through and listens to. These are saved on the server, so the same choices apply whether you open theDAW in a browser or as the desktop app. Every surface can be pointed somewhere else under Per-surface."
        meta={overrideCount > 0 ? `${overrideCount} override${overrideCount === 1 ? '' : 's'}` : undefined}
      >
        <button
          type="button"
          onClick={() => {
            void refresh();
            void refreshDisplays();
          }}
          aria-label="Re-scan devices"
          title="Re-scan connected devices"
          className={`${BTN_GHOST} ml-1`}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </SectionHeader>

      <div className={CARD}>
        {/* Main mix ------------------------------------------------------- */}
        <div className={ROW}>
          <span className={ROW_LABEL}>Main out</span>
          <IoGlobalSelect
            slot="audio_output"
            label="Main output device"
            className="flex-1"
            unsupported={
              supports.ctxSink
                ? undefined
                : 'this browser cannot move the main output — the desktop app can'
            }
          />
          {engine && (
            <span className={META}>
              {Math.round(engine.sampleRate / 100) / 10} kHz
              {engine.outputLatencyMs != null ? ` · ${engine.outputLatencyMs} ms` : ''}
            </span>
          )}
        </div>

        {/* Headphone cue --------------------------------------------------- */}
        <div className={ROW}>
          <span className={ROW_LABEL}>
            <Headphones className="w-3 h-3 inline mr-1 -mt-0.5" />
            Cue out
          </span>
          <IoGlobalSelect
            slot="cue_output"
            label="Headphone (cue) output device"
            className="flex-1"
            unsupported={
              supports.elementSink ? undefined : 'this browser cannot route the cue bus'
            }
          />
          {cueClashes && (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-300">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              same as main — pre-listen will be audible in the mix
            </span>
          )}
        </div>

        {/* Microphone ------------------------------------------------------ */}
        <div className={ROW}>
          <span className={ROW_LABEL}>Microphone</span>
          <IoGlobalSelect slot="audio_input" label="Microphone device" className="flex-1" />
          {micPermission === 'denied' && (
            <span className="text-[11px] font-mono text-rose-400">blocked by the browser</span>
          )}
        </div>

        {/* MIDI in --------------------------------------------------------- */}
        <div className={ROW}>
          <span className={ROW_LABEL}>MIDI in</span>
          <Segmented
            value={midiCfg.mode}
            options={[
              ['all', 'All'],
              ['some', 'Choose'],
            ]}
            onChange={(mode) =>
              void setMidiInputSelection(
                mode === 'all'
                  ? { mode: 'all', ports: [] }
                  : { mode: 'some', ports: midiIn.map((p) => ({ id: p.id, label: p.label })) },
              )
            }
            ariaLabel="Which MIDI inputs are used"
          />
          <span className={META}>{describeMidiInputs(midiCfg, midiIn.length)}</span>
          {!supports.midi && <span className={META}>Web MIDI unavailable</span>}
        </div>
        {midiCfg.mode === 'some' && (
          <div className="px-1.5 pb-1 flex flex-col gap-0.5">
            {midiIn.length === 0 && <span className={META}>nothing connected</span>}
            {midiIn.map((port) => {
              const id = `io-midi-in-${port.id}`;
              const on = midiCfg.ports.some((p) => p.id === port.id || (!!p.label && p.label === port.label));
              return (
                <div key={port.id} className="flex items-center gap-1.5">
                  <input
                    id={id}
                    name={id}
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      void setMidiInputSelection(
                        toggleMidiPort(midiCfg, { id: port.id, label: port.label }, e.target.checked),
                      )
                    }
                    className="accent-purple-500"
                  />
                  <label htmlFor={id} className={BODY}>
                    {port.label}
                  </label>
                </div>
              );
            })}
          </div>
        )}

        {/* MIDI out (thru) ------------------------------------------------- */}
        <div className={ROW}>
          <span className={ROW_LABEL}>MIDI out</span>
          <IoGlobalSelect
            slot="midi_output"
            label="MIDI thru output port"
            className="flex-1"
            unsupported={supports.midi ? undefined : 'Web MIDI is unavailable in this browser'}
          />
          <span className={META}>thru only — no clock is sent</span>
        </div>

        {/* Pop-out display -------------------------------------------------- */}
        <div className={ROW}>
          <span className={ROW_LABEL}>Pop-out screen</span>
          <IoGlobalSelect
            slot="visual_display"
            label="Monitor for pop-out windows"
            className="flex-1"
            unsupported={
              supports.displays ? undefined : 'desktop app only — a browser cannot place a window on a monitor'
            }
          />
        </div>

        {/* Camera — a status row, NOT a picker. See the note below. --------- */}
        <div className={ROW}>
          <span className={ROW_LABEL}>Camera</span>
          <span className={BODY}>Chosen inside the VJ panel</span>
        </div>
      </div>

      {!labelsKnown && (
        <p className={NOTE}>
          Device names fill in the first time something opens the microphone — until then the browser
          reports them blank.
        </p>
      )}

      {/* The fine-grained half ------------------------------------------------ */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="io-per-surface"
        className={`${BTN_GHOST} mt-1.5`}
      >
        {open ? 'Hide per-surface' : 'Per-surface…'}
      </button>
      <div id="io-per-surface" hidden={!open} className={`${CARD} mt-1.5`}>
        {IO_SURFACES.map((surface) => (
          <div key={surface.id} className={ROW}>
            <span className={ROW_LABEL} title={surface.hint}>
              {surface.label}
            </span>
            <IoSurfaceSelect surface={surface.id} className="flex-1" />
          </div>
        ))}
      </div>

      {/* Honest copy: what this menu cannot reach, and why. ------------------ */}
      <p className={NOTE}>
        The camera list lives in the VJ panel — device ids are scoped to the VJ&apos;s own origin, so
        theDAW cannot enumerate them from here.
      </p>
      <p className={NOTE}>
        Voice commands always use the system default microphone. In theDAW the browser&apos;s speech
        API has no device setting; the UNDERFIT orb runs inside underfit&apos;s own page on another
        origin, which cannot read these settings at all.
      </p>
      <p className={`${NOTE} ${SECTION_META}`}>
        Lyria, Foundry, Sway, UNDERFIT and the VJ canvas make sound in their own windows — theDAW
        cannot route those.
      </p>
    </div>
  );
};
