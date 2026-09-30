/**
 * ArpeggiatorPanel — the chord-progression arpeggiator UI (the MIDI tab's
 * alternate face, shown when the roll's "Arp" toggle is on). A faithful React
 * rebuild of Jake Albaugh's arpeggiator layout (keyboard strip, chord
 * progression grid, key/mode/steps/type/style selectors, live output) rehosted
 * on the app's Web Audio synth via `ArpPlayerEngine`. The current progression
 * can be dumped into the piano roll's note model with one click. The MIDI
 * strip's PLAY key starts and stops it through `playing`.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleMinus, CirclePlus, Minus, Piano, Plus, Music4, SquareMinus, SquarePlus } from 'lucide-react';
import {
  ArpPlayerEngine,
  DEFAULT_ARP_CONFIG,
  noteNameToMidi,
  type ArpConfig,
  type PatternType,
} from '../../lib/arpEngine';
import { COLUMN_CUE_PX, arpCompact, panelStep, rowPage, wholeRows, type PanelBox } from '../../lib/arpLayout';
import { getEngineCtx } from '../../state/playerStore';
import { usePianoRollStore, type PianoNote } from '../../state/pianoRollStore';
import { rollPartVoice } from '../../lib/rollPartVoice';
import { vstBaseChannel } from '../../lib/rollVstPlay';
import { auditionRollVstNote } from '../../state/rollInstruments';
import { playedRollBends } from '../../lib/pitchBend';
import { InstrumentPicker } from './InstrumentPicker';
import { CueKey, FIELD_LEGEND, KEY_ON, KEY_REST, MINI_GLYPH, STRIP_GLYPH, StripKey } from './midiDockKit';

const KEYS = 'C C# D D# E F F# G G# A A# B'.split(' ');
const OCTAVES = [2, 3, 4, 5, 6, 7];
const MODES = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'major', 'minor', 'melodic', 'harmonic'];
const INTERVALS = 'i ii iii iv v vi vii'.split(' ');
const STEP_OPTS = [3, 4, 5, 6];
const BPM_MIN = 20;
const BPM_MAX = 300;

/** Tiny polyline thumbnail of one arpeggio index pattern (port of _genPatternSvg). */
const PatternSvg: React.FC<{ pattern: number[] }> = ({ pattern }) => {
  const spacing = 2;
  const hi = Math.max(...pattern);
  const width = pattern.length * spacing + spacing;
  const height = hi + spacing * 2;
  let x = spacing;
  const pts = pattern.map((p) => {
    const y = height - p - spacing;
    const point = `${x},${y}`;
    x += spacing;
    return point;
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto pointer-events-none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth={0.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

/** A panel with an Orbitron heading. `count` prints after the title in the sans
 *  (Orbitron runs "(" into "1"). `dense` is the short dock's form: 4px over the
 *  heading, a 12px heading line with 2px under it, 6px at the foot, so the chord
 *  progression's seven rows end above the column's 12px scroll cue. A panel is a
 *  snap point of the column it scrolls in (`data-panel` names it for the
 *  column's scroll cues). */
const Section: React.FC<{
  title: string;
  count?: number;
  tip?: string;
  dense?: boolean;
  /** Keys on the heading's line, at its right end (the STYLE grid's scroll cues); 12px tall. */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, count, tip, dense = false, aside, className, children }) => {
  const heading = (
    <h3 className={`text-[12px] font-display font-extrabold uppercase et-ink-3 ${dense ? 'leading-none' : ''} ${aside ? '' : dense ? 'mb-0.5' : 'mb-1.5'}`} title={tip}>
      <span>{title}</span>
      {count != null && <span className="ml-1.5 font-sans font-bold tabular-nums">{count}</span>}
    </h3>
  );
  return (
    <section data-panel={title} className={`snap-start rounded-md border border-white/10 bg-black/30 ${dense ? 'px-1.5 pt-1 pb-1.5' : 'p-2'} ${className ?? ''}`}>
      {aside ? (
        <div className={`flex items-center gap-1 ${dense ? 'mb-0.5' : 'mb-1.5'}`}>
          {heading}
          <div className="ml-auto flex items-center gap-1">{aside}</div>
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
};

/**
 * A column cue: a 12px band over the column's end (COLUMN_CUE_PX), the action
 * rail's cue. The band only paints; its centred 24x12 chevron key (the kit's
 * CueKey) takes the press, so the keys under the band's edges keep theirs.
 */
const COLUMN_CUE = 'pointer-events-none absolute inset-x-0 z-10 h-3 flex items-center justify-center';

/** One end's cue band: the panel it scrolls to names its key. */
const ColumnCue: React.FC<{ dir: 1 | -1; title: string; onGo: () => void }> = ({ dir, title, onGo }) => (
  <div
    className={`${COLUMN_CUE} ${dir === 1 ? 'bottom-0' : 'top-0'}`}
    style={{ background: `linear-gradient(to ${dir === 1 ? 'top' : 'bottom'}, var(--et-canvas, #07050a) 45%, transparent)` }}
  >
    <CueKey dir={dir} name={`Scroll ${dir === 1 ? 'down' : 'up'} to ${title}`} word={title} onGo={onGo} />
  </div>
);

/**
 * A body column that scrolls when the dock is too short for its panels. A cue at
 * each end with more beyond it names the panel it scrolls to.
 *
 * Its scroll snaps to each panel's top and to the column's end. The scroll
 * padding is the cue's height, so a snapped panel's heading sits below the up
 * cue, and the end marker makes the last position a snap point: a panel taller
 * than the column can then be paged to its foot even when a fraction of a pixel
 * keeps it from covering the column there.
 */
const PanelColumn: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cues, setCues] = useState<{ up: string | null; down: string | null }>({ up: null, down: null });

  const panels = useCallback((): PanelBox[] => {
    const el = scrollRef.current;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-panel]')).map((p) => ({
      top: p.offsetTop,
      height: p.offsetHeight,
      title: p.dataset.panel ?? '',
    }));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const list = panels();
      const view = { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
      const up = panelStep(list, view, -1, COLUMN_CUE_PX)?.title ?? null;
      const down = panelStep(list, view, 1, COLUMN_CUE_PX)?.title ?? null;
      setCues((p) => (p.up === up && p.down === down ? p : { up, down }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    for (const c of Array.from(el.children)) ro?.observe(c);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [panels]);

  const go = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const step = panelStep(panels(), { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }, dir, COLUMN_CUE_PX);
    if (step) el.scrollTo({ top: step.top, behavior: 'smooth' });
  };

  return (
    <div className="relative min-w-0 min-h-0">
      {/* relative: the panels' offsetTop is measured from this scroller.
          scroll-pt-3 / scroll-pb-3: COLUMN_CUE_PX. */}
      <div ref={scrollRef} className={`relative h-full flex flex-col gap-2 overflow-y-auto no-scrollbar snap-y snap-mandatory scroll-pt-3 scroll-pb-3 ${className}`}>
        {children}
        {/* The end snap point; -mt-2 takes back the column's gap. */}
        <div aria-hidden="true" className="-mt-2 h-px shrink-0 snap-end" />
      </div>
      {cues.up && <ColumnCue dir={-1} title={cues.up} onGo={() => go(-1)} />}
      {cues.down && <ColumnCue dir={1} title={cues.down} onGo={() => go(1)} />}
    </div>
  );
};

// The MIDI dock's key grammar (midiDockKit): a chosen cell takes the theme
// accent and its bottom edge, every other cell rests.
const cellEdge = 'border-b transition-[color,box-shadow,border-color] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)]';
/** Side rail width: MIXOLYDIAN at 12px fits one of the mode grid's two cells. */
const SIDE_RAIL_PX = 216;
const cellBase = `text-[12px] font-display font-bold uppercase rounded-xs ${cellEdge} cursor-pointer select-none`;
const cellOn = KEY_ON;
const cellOff = KEY_REST;
/** A number field without the browser's spin buttons, which take width and push the value off centre. */
const NO_SPIN = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

/**
 * The STYLE panel. Its thumbnails sit in a grid exactly as tall as the whole
 * rows that fit the panel (lib/arpLayout `wholeRows`), so no row shows cut.
 * Every thumbnail is a snap point and the last one also the end, so the wheel
 * lands on whole rows too. The heading's line carries a cue for each way more
 * rows are, up on the left and down on the right; a cue with nothing more its
 * way keeps its slot hidden, so neither moves. A press pages by all but one of
 * the rows in view (`rowPage`).
 */
const StyleSection: React.FC<{
  dense: boolean;
  patterns: number[][];
  selected: number;
  onPick: (i: number) => void;
}> = ({ dense, patterns, selected, onPick }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ height: number | null; rows: number; total: number; step: number }>({ height: null, rows: 0, total: 0, step: 0 });
  const [cues, setCues] = useState({ up: false, down: false });

  const columnsOf = (grid: HTMLElement) => Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);

  // The grid's height follows the room its wrapper has, and the wrapper is
  // `flex-1`, so the height set here never changes the room it was read from.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const grid = gridRef.current;
    if (!wrap || !grid) return;
    const measure = () => {
      const first = grid.firstElementChild as HTMLElement | null;
      if (!first) return;
      const z = parseFloat(grid.closest('[data-layout-zoom]')?.getAttribute('data-layout-zoom') ?? '') || 1;
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
      const rowH = first.getBoundingClientRect().height / z;
      const room = wrap.getBoundingClientRect().height / z;
      const total = Math.ceil(grid.children.length / columnsOf(grid));
      const next = wholeRows(room, rowH, gap, total);
      const step = rowH + gap;
      setFit((p) =>
        p.height !== null && p.rows === next.rows && p.total === total && Math.abs(p.height - next.height) < 0.25 && Math.abs(p.step - step) < 0.25
          ? p
          : { height: next.height, rows: next.rows, total, step },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    if (grid.firstElementChild) ro.observe(grid.firstElementChild);
    return () => ro.disconnect();
  }, [patterns.length]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const update = () => {
      const up = grid.scrollTop > 1;
      const down = grid.scrollTop < grid.scrollHeight - grid.clientHeight - 1;
      setCues((p) => (p.up === up && p.down === down ? p : { up, down }));
    };
    update();
    grid.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(grid);
    return () => {
      grid.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [fit.height, patterns.length]);

  const go = (dir: 1 | -1) => {
    const grid = gridRef.current;
    if (!grid || !fit.step || !fit.rows) return;
    const row = rowPage(grid.scrollTop, fit.step, fit.rows, fit.total, dir);
    // A row's own offset, never row x step, so rounding cannot build up over 120 rows.
    const target =
      row >= Math.max(0, fit.total - fit.rows)
        ? grid.scrollHeight - grid.clientHeight
        : ((grid.children[row * columnsOf(grid)] as HTMLElement | undefined)?.offsetTop ?? row * fit.step);
    grid.scrollTo({ top: target, behavior: 'smooth' });
  };

  return (
    <Section
      dense={dense}
      title="Style"
      count={patterns.length}
      tip="The order each chord's notes are arpeggiated through. Each thumbnail is one note-order; click to choose."
      className="flex-1 min-h-0 flex flex-col"
      aside={
        <>
          <CueKey dir={-1} name="Scroll up to more styles" word="More styles" onGo={() => go(-1)} idle={!cues.up} />
          <CueKey dir={1} name="Scroll down to more styles" word="More styles" onGo={() => go(1)} idle={!cues.down} />
        </>
      }
    >
      <div ref={wrapRef} className="relative flex-1 min-h-0">
        {/* relative: each thumbnail's offsetTop is measured from this scroller. */}
        <div
          ref={gridRef}
          data-style-grid=""
          className="relative h-full grid content-start gap-1 overflow-y-auto no-scrollbar snap-y snap-mandatory text-zinc-200"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(30px, 1fr))', ...(fit.height != null ? { height: fit.height } : {}) }}
        >
          {patterns.map((pattern, i) => {
            const on = selected === i;
            return (
              <button
                key={i}
                type="button"
                aria-label={`Arpeggio style ${pattern.join('')}`}
                aria-pressed={on}
                onClick={() => onPick(i)}
                title={`Note order ${pattern.map((n) => n + 1).join('-')}`}
                className={`snap-start last:snap-end rounded-xs p-0.5 ${cellEdge} ${on ? cellOn : cellOff}`}
              >
                <PatternSvg pattern={pattern} />
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
};

export const ArpeggiatorPanel: React.FC<{ playing: boolean }> = ({ playing }) => {
  const engineRef = useRef<ArpPlayerEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ArpPlayerEngine();
  const engine = engineRef.current;

  const [cfg, setCfg] = useState<ArpConfig>({ ...DEFAULT_ARP_CONFIG });

  // Short dock: the face goes compact when the full chord progression would not
  // fit its column (lib/arpLayout). The switch reads the body, whose height the
  // compact form does not change, so it settles on the first measurement.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(arpCompact(el.clientHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The rag counts its odd 16ths from the roll's bar lines, so the engine
  // follows the roll's meter map and pickup as they change.
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  useEffect(() => {
    engine.setMeter({ meterMap, pickupSteps });
  }, [engine, meterMap, pickupSteps]);

  // The arpeggiator sounds as the part it writes into: the roll part being
  // edited (its VST3 instrument while that plays, else its program; a drum
  // part's kit is no voice for chords, so the picker's plays then).
  useEffect(() => {
    engine.voiceOf = () => {
      const voice = rollPartVoice();
      const vst = voice.vst;
      if (vst) {
        const channel = vstBaseChannel(vst.channel);
        const play = (midi: number, velocity: number, when: number, duration: number) => auditionRollVstNote(vst.entryId, channel, midi, velocity, when, duration);
        return voice.percussion || voice.program === undefined ? { play } : { program: voice.program, bank: voice.bank, play };
      }
      return voice.percussion || voice.program === undefined ? {} : { program: voice.program, bank: voice.bank };
    };
    return () => {
      engine.voiceOf = null;
    };
  }, [engine]);

  // The arpeggiator bends with the roll's lane A, its curve looping at the roll's length.
  const bends = usePianoRollStore((s) => s.bends);
  const lanes = usePianoRollStore((s) => s.lanes);
  const rollSteps = usePianoRollStore((s) => s.totalSteps);
  useEffect(() => {
    engine.setBend(playedRollBends(bends, lanes, rollSteps).get(0) ?? null, rollSteps);
  }, [engine, bends, lanes, rollSteps]);
  const [activeChord, setActiveChord] = useState<number>(-1);
  const [activeMidi, setActiveMidi] = useState<Set<number>>(new Set());
  const timeoutsRef = useRef<number[]>([]);

  // Patch engine + local mirror together so the UI and the scheduler agree.
  const patch = (p: Partial<ArpConfig>): void => {
    engine.setConfig(p);
    setCfg({ ...engine.cfg });
  };

  const clearTimers = (): void => {
    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current = [];
  };

  useEffect(() => {
    engine.onTick = ({ when, chordIndex, trebleMidi, bassMidi }) => {
      const ctx = getEngineCtx();
      const delay = Math.max(0, (when - ctx.currentTime) * 1000);
      const id = window.setTimeout(() => {
        setActiveChord(chordIndex);
        setActiveMidi((prev) => {
          const next = new Set(prev);
          next.add(trebleMidi);
          if (bassMidi !== null) {
            // a fresh bass note clears the prior held bass below its register
            for (const m of next) if (m < 48) next.delete(m);
            next.add(bassMidi);
          }
          // keep the held bass + only the latest treble: drop stale trebles
          for (const m of next) if (m >= 48 && m !== trebleMidi) next.delete(m);
          return next;
        });
      }, delay);
      timeoutsRef.current.push(id);
      // prune fired timers occasionally
      if (timeoutsRef.current.length > 256) {
        timeoutsRef.current = timeoutsRef.current.slice(-64);
      }
    };
    engine.onStop = () => {
      clearTimers();
      setActiveChord(-1);
      setActiveMidi(new Set());
    };
    return () => {
      engine.dispose();
      clearTimers();
    };
    // engine is stable (ref); run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the strip's PLAY key. Declared after the tick handlers, so a start
  // on mount already has them.
  useEffect(() => {
    if (playing) engine.start();
    else engine.stop();
  }, [engine, playing]);

  const sendToRoll = (): void => {
    const notes = engine.renderProgression();
    const piano: PianoNote[] = notes.map((n, i) => ({
      id: `arp-${i}-${n.step}-${n.midi}`,
      note: n.midi,
      step: n.step,
      length: n.length,
      velocity: n.velocity,
    }));
    usePianoRollStore.getState().importNotes(piano, cfg.bpm);
  };

  const out = engine.outputChords();
  const scaleName = engine.MS._scale?.name ?? '';
  const patternList = engine.AP.patterns[cfg.patternType];

  // active note set for keyboard highlight, by midi
  const trebleMidis = useMemo(() => activeMidi, [activeMidi]);

  const setBpm = (v: number): void =>
    patch({ bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v) || BPM_MIN)) });

  const qPct = Math.round(cfg.quantize * 100);
  const ragPct = Math.round(cfg.swing * 100);
  // small segmented pill (steps / type)
  const pill = `px-2 py-0.5 text-[12px] font-display font-bold rounded-xs ${cellEdge} cursor-pointer select-none`;
  const fieldBox = 'flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded';

  return (
    <div className="h-full w-full flex flex-col bg-[#07050a] text-zinc-100 overflow-hidden">
      {/* toolbar — the arpeggiator's settings; it plays from the strip's PLAY key.
          Each −/+ pair is a pair of mini keys with its own glyphs and DockTips.
          Each field's printed legend is its native field's label, and the field's
          explanation sits on the field itself, so no key sits under a title. */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2 py-1 border-b border-white/5 bg-black/40">
        <span className="text-[12px] font-display font-extrabold uppercase et-ink" title="Chord-progression arpeggiator — pick a key, mode and chords; it arpeggiates them live through theDAW's synth.">Arp</span>
        <span className="text-[12px] font-semibold text-zinc-500" title="Current key + scale">{engine.MS.key} {scaleName}</span>

        {/* BPM */}
        <div className={fieldBox}>
          <label htmlFor="arp-bpm" className={FIELD_LEGEND}>BPM</label>
          <StripKey
            mini
            iconOnly
            aria-label="Decrease BPM"
            description="Slow the tempo by 5 BPM"
            onClick={() => setBpm(cfg.bpm - 5)}
            icon={<Minus className={MINI_GLYPH} />}
            legend="Decrease BPM"
          />
          <input
            id="arp-bpm" name="arp-bpm" type="number" min={BPM_MIN} max={BPM_MAX} value={cfg.bpm}
            title="Tempo in beats per minute. Type a value or use −/+ to step by 5."
            onChange={(e) => setBpm(parseInt(e.target.value, 10))}
            className={`bg-transparent border-none outline-none text-[12px] font-bold tabular-nums et-accent-legend w-9 text-center ${NO_SPIN}`}
          />
          <StripKey
            mini
            iconOnly
            aria-label="Increase BPM"
            description="Speed the tempo up by 5 BPM"
            onClick={() => setBpm(cfg.bpm + 5)}
            icon={<Plus className={MINI_GLYPH} />}
            legend="Increase BPM"
          />
        </div>

        {/* Steps */}
        <div className="flex items-center gap-1" title="Notes per arpeggio (3-6). More steps = busier, longer pattern.">
          <span className="text-[12px] font-display font-bold et-ink-3 uppercase">Steps</span>
          {STEP_OPTS.map((s) => {
            const on = cfg.steps === s;
            return (
              <button key={s} type="button" aria-label={`Arpeggio steps ${s}`} aria-pressed={on}
                onClick={() => patch({ steps: s })} title={`${s} notes per arpeggio (more steps = busier pattern)`} className={`${pill} ${on ? cellOn : cellOff}`}>
                <span>{s}</span>
              </button>
            );
          })}
        </div>

        {/* Type */}
        <div className="flex items-center gap-1">
          {(['straight', 'looped'] as PatternType[]).map((t) => {
            const on = cfg.patternType === t;
            return (
              <button key={t} type="button" aria-label={`Arpeggio type ${t}`} aria-pressed={on}
                onClick={() => patch({ patternType: t })}
                title={t === 'straight' ? 'Straight: play the note order once per chord' : 'Looped: play the order then mirror back down'}
                className={`${pill} capitalize ${on ? cellOn : cellOff}`}>
                <span>{t}</span>
              </button>
            );
          })}
        </div>

        {/* Quantize + Rag (live timing feel, same as the piano roll) */}
        <div className={fieldBox}>
          <label htmlFor="arp-quantize" className={FIELD_LEGEND}>Quant</label>
          <StripKey
            mini
            iconOnly
            aria-label="Decrease quantize"
            description="Loosen the timing by 1%: less quantize humanizes it"
            onClick={() => patch({ quantize: Math.max(0, qPct - 1) / 100 })}
            icon={<CircleMinus className={MINI_GLYPH} />}
            legend="Decrease quantize"
          />
          <input id="arp-quantize" name="arp-quantize" type="range" min={0} max={100} value={qPct}
            title="Quantize: 100% = dead-on grid; lower humanizes timing. Use −/+ for single-percent steps."
            onChange={(e) => patch({ quantize: (parseInt(e.target.value, 10) || 0) / 100 })} className="w-16 accent-[rgb(var(--et-accent))]" />
          <StripKey
            mini
            iconOnly
            aria-label="Increase quantize"
            description="Tighten the timing by 1%: 100% is dead on the grid"
            onClick={() => patch({ quantize: Math.min(100, qPct + 1) / 100 })}
            icon={<CirclePlus className={MINI_GLYPH} />}
            legend="Increase quantize"
          />
          {/* "100%" is 31px at 12px bold. Left-aligned, so every value sits the field's
              4px gap from its increase key, whatever its length. */}
          <span className="text-[12px] font-bold tabular-nums whitespace-nowrap et-accent-legend w-8 text-left">{qPct}%</span>
          <label htmlFor="arp-rag" className={`${FIELD_LEGEND} ml-1`}>Rag</label>
          <StripKey
            mini
            iconOnly
            aria-label="Decrease rag"
            description="Push the off-16ths 1% earlier"
            onClick={() => patch({ swing: Math.max(-50, ragPct - 1) / 100 })}
            icon={<SquareMinus className={MINI_GLYPH} />}
            legend="Decrease rag"
          />
          <input id="arp-rag" name="arp-rag" type="range" min={-50} max={50} value={ragPct}
            title="Rag (swing) delays (+) or pushes (−) the off-16ths. Use −/+ for single-percent steps."
            onChange={(e) => patch({ swing: (parseInt(e.target.value, 10) || 0) / 100 })} className="w-16 accent-[rgb(var(--et-accent))]" />
          <StripKey
            mini
            iconOnly
            aria-label="Increase rag"
            description="Delay the off-16ths 1% later"
            onClick={() => patch({ swing: Math.min(50, ragPct + 1) / 100 })}
            icon={<SquarePlus className={MINI_GLYPH} />}
            legend="Increase rag"
          />
          {/* "+50%" is 33px at 12px bold; left-aligned like QUANT's. */}
          <span className="text-[12px] font-bold tabular-nums whitespace-nowrap et-accent-legend w-9 text-left">{ragPct > 0 ? '+' : ''}{ragPct}%</span>
        </div>

        {/* Own id prefix: the arpeggiator and the Piano Roll are both mounted
            at once (MidiPanel keeps the roll alive behind the arp face), so the
            default `pr-instrument` id would exist twice in one document. */}
        <InstrumentPicker idPrefix="arp-instrument" legendClassName={FIELD_LEGEND} />

        {/* Bass */}
        <button
          type="button" aria-label="Toggle bass voice" aria-pressed={cfg.bassOn}
          onClick={() => patch({ bassOn: !cfg.bassOn })} title="Bass voice"
          className={`${pill} flex items-center gap-1 ${cfg.bassOn ? cellOn : cellOff}`}
        >
          <Music4 aria-hidden="true" className="w-3 h-3" />
          <span>Bass</span>
        </button>

        <div className="flex-1" />
        <StripKey
          onClick={sendToRoll}
          description="Render the progression into the piano roll's notes, then morph it with the SHAPE row below"
          icon={<Piano className={STRIP_GLYPH} />}
          legend="Piano roll"
        />
      </div>

      {/* body: TONIC/MODE (left rail) · CHORDS + OUTPUT (center hero) · STYLES (right rail) */}
      <div ref={bodyRef} className={`flex-1 min-h-0 ${compact ? 'px-2 py-1' : 'p-2'} grid grid-rows-1 gap-2`} style={{ gridTemplateColumns: `${SIDE_RAIL_PX}px minmax(0,1fr) ${SIDE_RAIL_PX}px` }}>
        {/* left rail: tonic + mode */}
        <PanelColumn>
          <Section dense={compact} title="Tonic / root" tip="The key center. Every chord is built from this root note plus the chosen mode.">
            <div className="grid grid-cols-4 gap-1">
              {KEYS.map((key) => {
                const on = cfg.key === key;
                return (
                  <button key={key} type="button" aria-label={`Key ${key}`} aria-pressed={on}
                    onClick={() => patch({ key })} title={`Set the tonic (root) to ${key}`} className={`${cellBase} w-full py-1 ${on ? cellOn : cellOff}`}>
                    {key}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section dense={compact} title="Mode" tip="The scale/mode that colors the chords (major, minor, dorian, …). Changes which chords are major/minor/diminished.">
            <div className="grid grid-cols-2 gap-1">
              {MODES.map((mode) => {
                const on = cfg.mode === mode;
                return (
                  <button key={mode} type="button" aria-label={`Mode ${mode}`} aria-pressed={on}
                    onClick={() => patch({ mode })} title={`Use the ${mode} scale/mode for the chords`} className={`${cellBase} w-full py-1 capitalize truncate ${on ? cellOn : cellOff}`}>
                    {mode}
                  </button>
                );
              })}
            </div>
          </Section>
        </PanelColumn>

        {/* center hero: the chord progression fills the space; output aligns
            directly beneath each chord column. */}
        <PanelColumn>
          {/* The section and its slots keep their content height as a minimum,
              so a short column scrolls; the keys never squash into each other. */}
          <Section dense={compact} title="Chord progression" tip="Eight progression slots, left to right. Each column is one slot — click a scale degree to set which chord plays there. The lit column is playing now." className="flex-1 flex flex-col">
            <div className="flex-1 flex gap-1.5">
              {cfg.chords.map((sel, c) => (
                <div key={c} className={`flex-1 min-w-0 flex flex-col ${compact ? 'gap-px' : 'gap-1'} rounded-xs ${activeChord === c ? 'ring-2 ring-[rgb(var(--et-accent))]' : ''}`}>
                  {INTERVALS.map((_label, i) => {
                    const on = sel === i;
                    const interval = engine.MS.notes[i]?.triad.interval ?? INTERVALS[i];
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-label={`Chord ${c + 1} degree ${interval}`}
                        aria-pressed={on}
                        onClick={() => {
                          const chords = [...cfg.chords];
                          chords[c] = i;
                          patch({ chords });
                        }}
                        title={`Slot ${c + 1}: play the ${interval} chord (scale degree ${i + 1}) here`}
                        className={`flex-1 font-display font-bold rounded-xs ${cellEdge} cursor-pointer ${compact ? 'min-h-3.25 text-[12px] leading-none' : 'min-h-6 text-[13px]'} ${on ? cellOn : cellOff}`}
                      >
                        {interval}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </Section>

          <Section dense={compact} title="Output" tip="The actual chord in each slot (note + quality), lit as it plays. Each chip sits under its progression column." className="shrink-0">
            <div className="flex gap-1.5">
              {out.map((chord, i) => (
                <div
                  key={i}
                  className={`flex-1 min-w-0 truncate text-center px-1 py-1 rounded-xs border text-[12px] font-semibold ${
                    activeChord === i
                      ? 'border-[rgb(var(--et-accent))] bg-[rgb(var(--et-accent)/0.12)] et-accent-legend'
                      : 'border-white/10 bg-white/5 text-zinc-200'
                  }`}
                  title={`${chord.note}${chord.type} · ${chord.interval}`}
                >
                  <span className="font-bold">{chord.note}</span>
                  <span className="text-zinc-400 lowercase">{chord.type}</span>
                </div>
              ))}
            </div>
          </Section>
        </PanelColumn>

        {/* right rail: arpeggio styles, whole rows with their own cues (StyleSection) */}
        <div className="flex flex-col gap-2 min-w-0 min-h-0">
          <StyleSection dense={compact} patterns={patternList} selected={cfg.patternId} onPick={(i) => patch({ patternId: i })} />
        </div>
      </div>

      {/* keyboard strip — anchored to the bottom of the panel */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <div className="flex gap-px rounded overflow-hidden border border-white/10 bg-black/40">
          {OCTAVES.map((octave) =>
            KEYS.map((key) => {
              const midi = noteNameToMidi(key, octave);
              const black = key.includes('#');
              const on = trebleMidis.has(midi);
              // A fixed black-key colour: the theme remaps bg-zinc-800 to its
              // panel, which on a light theme makes the black keys as pale as the white ones.
              return (
                <div
                  key={`${key}${octave}`}
                  aria-hidden="true"
                  className={`${black ? 'flex-2' : 'flex-3'} h-9 ${
                    on ? (black ? 'bg-[rgb(var(--et-accent)/0.7)]' : 'bg-[rgb(var(--et-accent))]') : black ? 'bg-[#27272a]' : 'bg-zinc-200/85'
                  } transition-colors`}
                />
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
};
