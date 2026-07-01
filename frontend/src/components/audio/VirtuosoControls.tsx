/**
 * VirtuosoControls — the shared morph strip for the virtuoso transforms (harmony /
 * ragtime / runs / polyrhythm / humanize). Mounted once in the MIDI tab between
 * the toolbar and the body, so it is visible from both the piano roll and the
 * arpeggiator faces (no switching). Each amount has a slider plus -/+ step buttons
 * for fine adjustment; changes re-render the roll live from the captured source.
 * Capture snapshots the current roll as the morph base; Build assembles a full
 * multi-section arrangement. The Structure toggle opens a song-structure
 * configurator that lays out the sections (role + bar count) the build uses.
 */
import React from 'react';
import { useVirtuosoStore } from '../../state/virtuosoStore';
import { LibraryMidiPicker } from './LibraryMidiPicker';
import { logError } from '../../state/logStore';
import {
  STYLES,
  STYLE_NAMES,
  ROLES,
  ROLE_LABELS,
  defaultSections,
  type VirtuosoAmounts,
  type StyleName,
  type Role,
} from '../../lib/virtuosoTransform';

const KEYS = 'C C# D D# E F F# G G# A A# B'.split(' ');
const MODES = [
  'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
  'major', 'minor', 'melodic', 'harmonic',
];

const STEP = 0.05;

const SLIDERS: Array<{ k: keyof VirtuosoAmounts; label: string; accent: string; track: string }> = [
  { k: 'harmony', label: 'Harmony', accent: 'accent-cyan-400', track: 'text-cyan-300' },
  { k: 'ragtime', label: 'Ragtime', accent: 'accent-amber-400', track: 'text-amber-300' },
  { k: 'runs', label: 'Runs', accent: 'accent-fuchsia-400', track: 'text-fuchsia-300' },
  { k: 'rhythm', label: 'Polyrhythm', accent: 'accent-emerald-400', track: 'text-emerald-300' },
  { k: 'humanize', label: 'Humanize', accent: 'accent-rose-400', track: 'text-rose-300' },
];

const stepBtn =
  'shrink-0 w-4 h-4 leading-none flex items-center justify-center rounded border border-white/15 text-zinc-300 hover:border-white/40 hover:text-white text-[11px] font-bold select-none';

const SongStructure: React.FC = () => {
  // Select raw state and derive the effective list with useMemo — calling
  // effectiveSections() inside the selector returns a fresh array each render
  // (the default path) and drives an infinite re-render loop.
  const rawSections = useVirtuosoStore((s) => s.sections);
  const style = useVirtuosoStore((s) => s.style);
  const setSectionRole = useVirtuosoStore((s) => s.setSectionRole);
  const setSectionBars = useVirtuosoStore((s) => s.setSectionBars);
  const addSection = useVirtuosoStore((s) => s.addSection);
  const removeSection = useVirtuosoStore((s) => s.removeSection);
  const moveSection = useVirtuosoStore((s) => s.moveSection);
  const resetSections = useVirtuosoStore((s) => s.resetSections);
  const custom = rawSections != null;
  const sections = React.useMemo(() => rawSections ?? defaultSections(style), [rawSections, style]);

  const totalBars = sections.reduce((n, x) => n + x.bars, 0);

  return (
    <div className="shrink-0 flex flex-col gap-1 px-2 py-1.5 border-b border-white/8 bg-black/40">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-black uppercase tracking-[0.18em] text-purple-300">Structure</span>
        <span className="text-[8px] font-mono text-zinc-500">
          {sections.length} sections / {totalBars} bars{custom ? '' : ' (style default)'}
        </span>
        <button
          type="button"
          onClick={addSection}
          className="ml-auto px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase rounded border border-white/15 text-zinc-300 hover:bg-white/10"
        >
          + Section
        </button>
        <button
          type="button"
          onClick={resetSections}
          title="Discard the custom layout and follow the style's default structure."
          className="px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase rounded border border-white/15 text-zinc-300 hover:bg-white/10"
        >
          Reset
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {sections.map((sec, i) => (
          <div key={i} className="flex items-center gap-0.5 rounded border border-white/10 bg-white/3 px-1 py-0.5">
            <span className="text-[8px] font-mono text-zinc-500 w-3 text-right">{i + 1}</span>
            <button
              type="button"
              className={stepBtn}
              aria-label={`Move section ${i + 1} earlier`}
              onClick={() => moveSection(i, -1)}
            >
              ‹
            </button>
            <label htmlFor={`vt-sec-role-${i}`} className="sr-only">{`Section ${i + 1} role`}</label>
            <select
              id={`vt-sec-role-${i}`}
              name={`vt-sec-role-${i}`}
              value={sec.role}
              onChange={(e) => setSectionRole(i, e.target.value as Role)}
              className="bg-black/50 border border-zinc-800 rounded px-1 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <label htmlFor={`vt-sec-bars-${i}`} className="sr-only">{`Section ${i + 1} bars`}</label>
            <input
              id={`vt-sec-bars-${i}`}
              name={`vt-sec-bars-${i}`}
              type="number"
              min={1}
              max={16}
              value={sec.bars}
              onChange={(e) => setSectionBars(i, parseInt(e.target.value, 10) || 1)}
              className="w-9 bg-black/50 border border-zinc-800 rounded px-1 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50"
            />
            <button
              type="button"
              className={stepBtn}
              aria-label={`Move section ${i + 1} later`}
              onClick={() => moveSection(i, 1)}
            >
              ›
            </button>
            <button
              type="button"
              className="shrink-0 w-4 h-4 leading-none flex items-center justify-center rounded border border-white/15 text-rose-300/80 hover:border-rose-400/60 hover:text-rose-200 text-[11px] font-bold"
              aria-label={`Remove section ${i + 1}`}
              onClick={() => removeSection(i)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export const VirtuosoControls: React.FC = () => {
  const amounts = useVirtuosoStore((s) => s.amounts);
  const setAmount = useVirtuosoStore((s) => s.setAmount);
  const nudge = useVirtuosoStore((s) => s.nudge);
  const keyV = useVirtuosoStore((s) => s.key);
  const modeV = useVirtuosoStore((s) => s.mode);
  const setKey = useVirtuosoStore((s) => s.setKey);
  const setMode = useVirtuosoStore((s) => s.setMode);
  const style = useVirtuosoStore((s) => s.style);
  const setStyle = useVirtuosoStore((s) => s.setStyle);
  const songMode = useVirtuosoStore((s) => s.songMode);
  const captureSource = useVirtuosoStore((s) => s.captureSource);
  const resetToSource = useVirtuosoStore((s) => s.resetToSource);
  const buildSong = useVirtuosoStore((s) => s.buildSong);
  const groove = useVirtuosoStore((s) => s.groove);
  const setGrooveFromBytes = useVirtuosoStore((s) => s.setGrooveFromBytes);
  const clearGroove = useVirtuosoStore((s) => s.clearGroove);
  const [showStructure, setShowStructure] = React.useState(false);
  const [pickGroove, setPickGroove] = React.useState(false);

  return (
    <>
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b border-white/8 bg-black/30">
        <span
          className="text-[9px] font-black uppercase tracking-[0.18em] text-purple-300"
          title="Morph the piano roll into virtuoso lines. Dial each amount; the roll re-renders live from the captured source."
        >
          Virtuoso
        </span>

        {SLIDERS.map(({ k, label, accent, track }) => (
          <div key={k} className="flex items-center gap-1" title={`${label} amount`}>
            <span className={`w-16 text-[9px] font-mono font-semibold uppercase tracking-wide ${track}`}>{label}</span>
            <button type="button" className={stepBtn} aria-label={`Decrease ${label}`} onClick={() => nudge(k, -STEP)}>−</button>
            <label htmlFor={`vt-${k}`} className="sr-only">{`${label} amount`}</label>
            <input
              id={`vt-${k}`}
              name={`vt-${k}`}
              type="range"
              min={0}
              max={100}
              value={Math.round(amounts[k] * 100)}
              onChange={(e) => setAmount(k, (parseInt(e.target.value, 10) || 0) / 100)}
              className={`w-20 ${accent}`}
            />
            <button type="button" className={stepBtn} aria-label={`Increase ${label}`} onClick={() => nudge(k, STEP)}>+</button>
            <span className="w-6 text-right text-[8px] font-mono text-zinc-400">{Math.round(amounts[k] * 100)}</span>
          </div>
        ))}

        <div className="flex items-center gap-1" title="Key + scale the transforms use">
          <label htmlFor="vt-key" className="sr-only">Key</label>
          <select
            id="vt-key" name="vt-key" value={keyV} onChange={(e) => setKey(e.target.value)}
            className="bg-black/40 border border-zinc-800 rounded px-1 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50"
          >
            {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label htmlFor="vt-mode" className="sr-only">Mode</label>
          <select
            id="vt-mode" name="vt-mode" value={modeV} onChange={(e) => setMode(e.target.value)}
            className="bg-black/40 border border-zinc-800 rounded px-1 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50 capitalize"
          >
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-1" title="Composition style for Build Song (sets the scale, section structure, dynamics and feel)">
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Style</span>
          <label htmlFor="vt-style" className="sr-only">Composition style</label>
          <select
            id="vt-style" name="vt-style" value={style} onChange={(e) => setStyle(e.target.value as StyleName)}
            className="bg-black/40 border border-zinc-800 rounded px-1 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50"
          >
            {STYLE_NAMES.map((s) => <option key={s} value={s}>{STYLES[s].label}</option>)}
          </select>
        </div>

        <div
          className="flex items-center gap-1"
          title="Drive the Humanize timing/feel from a reference song's groove (a Library track's transcribed MIDI). Timing pocket + rhythmic emphasis are learned; transcription does not recover dynamics."
        >
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Groove</span>
          {groove ? (
            <>
              <span className="max-w-24 truncate text-[9px] font-mono text-rose-200" title={groove.name}>{groove.name}</span>
              <button
                type="button"
                className="shrink-0 w-4 h-4 leading-none flex items-center justify-center rounded border border-white/15 text-rose-300/80 hover:border-rose-400/60 hover:text-rose-200 text-[11px] font-bold"
                aria-label="Clear groove reference"
                onClick={clearGroove}
              >
                ×
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPickGroove(true)}
              className="px-2 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wide rounded border border-rose-500/40 text-rose-200 hover:bg-rose-500/20"
            >
              Pick
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button" onClick={captureSource}
            title="Snapshot the current piano roll as the morph source (re-grab after changing the arp or notes)."
            className="px-2 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wide rounded border border-purple-500/40 text-purple-200 hover:bg-purple-500/20"
          >
            Capture
          </button>
          <button
            type="button" onClick={resetToSource}
            title="Reset amounts to zero and restore the captured source to the roll."
            className="px-2 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wide rounded border border-white/15 text-zinc-300 hover:bg-white/10"
          >
            Reset
          </button>
          <button
            type="button" onClick={() => setShowStructure((v) => !v)}
            aria-pressed={showStructure}
            aria-controls="vt-structure"
            title="Open the song-structure configurator: lay out the sections (intro, theme, build, chorus, solo, climax, outro) and their length that Build Song uses."
            className={`px-2 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wide rounded border ${
              showStructure ? 'border-purple-400 bg-purple-500/25 text-purple-100' : 'border-white/15 text-zinc-300 hover:bg-white/10'
            }`}
          >
            Structure
          </button>
          <button
            type="button" onClick={buildSong}
            aria-pressed={songMode}
            title="Build a full, developing arrangement from the source in the chosen style/structure, with voice-leading, a melody, a crescendo, and rubato. While built, the sliders reshape the whole song; Reset returns to the phrase."
            className={`px-2 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wide rounded border ${
              songMode
                ? 'border-fuchsia-400 bg-fuchsia-500/25 text-fuchsia-100'
                : 'border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/20'
            }`}
          >
            {songMode ? 'Song' : 'Build Song'}
          </button>
        </div>
      </div>

      {showStructure && (
        <div id="vt-structure">
          <SongStructure />
        </div>
      )}

      <LibraryMidiPicker
        open={pickGroove}
        title="Pick a groove reference"
        onClose={() => setPickGroove(false)}
        onPick={(bytes, label) => {
          const ok = setGrooveFromBytes(bytes, label);
          if (!ok) logError('virtuoso', 'That MIDI had no notes to learn a groove from.');
          setPickGroove(false);
        }}
      />
    </>
  );
};
