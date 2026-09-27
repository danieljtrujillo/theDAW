import React from 'react';
import { create } from 'zustand';
import { Loader2, Piano, TriangleAlert } from 'lucide-react';
import { useSoundfontStore, ensureSoundfontReady } from '../../lib/soundfontEngine';
import { GM_NAMES } from '../../lib/gmInstruments';
import { describeInstrument, orchestraByFamily, orchestraInstrument } from '../../lib/orchestra';
import { SYNTH_VOICES } from '../../lib/synthVoices';
import { DOCK_SELECT } from './midiDockKit';

const VOICE_GROUPS = Array.from(new Set(SYNTH_VOICES.map((v) => v.group)));

// The orchestral registry's pitched instruments by family, in score order.
// An unpitched percussion record plays one key of the drum kit on the drum
// channel, and this picker sets one melodic program for the preview voice, so
// those records are left to parts that carry a drum channel.
const ORCHESTRA_GROUPS = orchestraByFamily((i) => !i.percussion);

// The orchestral instrument last picked, shared by every mounted picker so a
// second picker shows the same choice. It shows while the active program is
// still that instrument's program; any other choice clears it.
const useOrchestraPick = create<{ id: string | null; setId: (id: string | null) => void }>((set) => ({
  id: null,
  setId: (id) => set({ id }),
}));

/**
 * Single dropdown that picks the MIDI voice: the built-in sawtooth ("Basic") or
 * a General MIDI soundfont program, or an orchestral instrument from the
 * registry (lib/orchestra.ts), listed by family in score order, which sets that
 * instrument's GM program. Drives the shared soundfont store, so the
 * choice applies to live preview, playback, and offline WAV bounce alike.
 *
 * `idPrefix` exists because the id used to be hardcoded `pr-instrument`: any
 * second mount (a picker open beside the Piano Roll) produced two elements with
 * the same id and a <label htmlFor> that named whichever came first. Callers
 * that can co-exist with the roll pass their own prefix.
 *
 * `compact` is the MIDI dock strip's form: a piano glyph in place of the visible
 * word, a narrow select, and the loading / failure notes as glyphs whose text is
 * in their title and in a screen-reader-only span.
 *
 * `legendClassName` sets the visible "Instrument" label's type in the full
 * form, so a toolbar can print it like its other legends (the ARP face).
 */
export const InstrumentPicker: React.FC<{ idPrefix?: string; compact?: boolean; legendClassName?: string }> = ({
  idPrefix = 'pr-instrument',
  compact = false,
  legendClassName = 'text-xs font-semibold text-white/50',
}) => {
  const useSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const activeProgram = useSoundfontStore((s) => s.activeProgram);
  const activeSynthVoice = useSoundfontStore((s) => s.activeSynthVoice);
  const loading = useSoundfontStore((s) => s.loading);
  const loadError = useSoundfontStore((s) => s.loadError);
  const setUseSoundfont = useSoundfontStore((s) => s.setUseSoundfont);
  const setActiveProgram = useSoundfontStore((s) => s.setActiveProgram);
  const setActiveSynthVoice = useSoundfontStore((s) => s.setActiveSynthVoice);

  const orchestraPick = useOrchestraPick((s) => s.id);
  const remember = useOrchestraPick((s) => s.setId);
  const picked = orchestraInstrument(orchestraPick);
  const soundfontValue = picked && picked.program === activeProgram ? `o:${picked.id}` : String(activeProgram);
  const value = activeSynthVoice ? `v:${activeSynthVoice}` : useSoundfont ? soundfontValue : 'basic';

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v.startsWith('o:')) {
      const inst = orchestraInstrument(v.slice(2));
      if (!inst) return;
      remember(inst.id);
      setActiveProgram(inst.program);
      setUseSoundfont(true); // clears any synth voice
      void ensureSoundfontReady(); // warm the worklet + soundfont while the user looks
      return;
    }
    remember(null);
    if (v === 'basic') {
      setUseSoundfont(false);
      setActiveSynthVoice(null);
      return;
    }
    if (v.startsWith('v:')) {
      setActiveSynthVoice(v.slice(2)); // procedural EDM voice (clears soundfont)
      return;
    }
    setActiveProgram(Number(v));
    setUseSoundfont(true); // clears any synth voice
    void ensureSoundfontReady(); // warm the worklet + soundfont while the user looks
  };

  const options = (
    <>
      <option value="basic">Basic (sawtooth)</option>
      {VOICE_GROUPS.map((g) => (
        <optgroup key={g} label={`Synth · ${g}`}>
          {SYNTH_VOICES.filter((vv) => vv.group === g).map((vv) => (
            <option key={vv.id} value={`v:${vv.id}`}>{vv.name}</option>
          ))}
        </optgroup>
      ))}
      {ORCHESTRA_GROUPS.map((g) => (
        <optgroup key={g.family.id} label={`Orchestra · ${g.family.label}`}>
          {g.instruments.map((inst) => (
            <option key={inst.id} value={`o:${inst.id}`} title={describeInstrument(inst)}>
              {inst.name}
            </option>
          ))}
        </optgroup>
      ))}
      <optgroup label="General MIDI">
        {GM_NAMES.map((n, i) => (
          <option key={n} value={i}>{`${i + 1}. ${n}`}</option>
        ))}
      </optgroup>
    </>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-1 shrink-0" title="Instrument">
        <label htmlFor={idPrefix} className="sr-only">
          Instrument
        </label>
        <Piano aria-hidden="true" className="w-3 h-3 shrink-0 et-ink-3" />
        <select
          id={idPrefix}
          name={idPrefix}
          aria-label="MIDI instrument"
          value={value}
          onChange={onChange}
          className={`${DOCK_SELECT} w-40`}
        >
          {options}
        </select>
        {loading && (
          <span className="flex et-ink-3" title="Loading the soundfont">
            <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" />
            <span className="sr-only">loading…</span>
          </span>
        )}
        {loadError && (
          <span className="flex text-red-300" title={`Soundfont failed: ${loadError}`}>
            <TriangleAlert aria-hidden="true" className="w-3 h-3" />
            <span className="sr-only">soundfont failed</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={idPrefix} className={legendClassName}>
        Instrument
      </label>
      <select
        id={idPrefix}
        name={idPrefix}
        aria-label="MIDI instrument"
        value={value}
        onChange={onChange}
        className="form-select px-2 py-1 text-xs font-semibold max-w-44"
        style={{ colorScheme: 'dark' }}
      >
        {options}
      </select>
      {loading && <span className="text-xs font-semibold text-white/40">loading…</span>}
      {loadError && (
        <span className="text-xs font-semibold text-red-300" title={loadError}>
          soundfont failed
        </span>
      )}
    </div>
  );
};
