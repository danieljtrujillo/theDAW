import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { generatePianoFromParams, type AiComposeResult } from '../../lib/aiComposeClient';
import { logError, logInfo } from '../../state/logStore';

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MODES = [
  'major',
  'minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'harmonic minor',
];
// Curated composition styles (pianistic + a few genre colours the user asked for).
const STYLES = [
  'None',
  'Romantic',
  'Baroque',
  'Impressionist',
  'Neo-classical',
  'Ragtime',
  'Jazz ballad',
  'Smooth jazz',
  'Fire-jazz',
  'Cinematic',
  'Lo-fi',
  'Futurebass',
  'Prog',
];

/**
 * AI COMPOSE control for the Piano Roll. Opens a small parameter form, asks a
 * Gemini model (through theDAW's server-side proxy) to write a two-hand piano
 * part, and hands the resulting notes back to the roll.
 */
export const AiComposePopover: React.FC<{
  currentBpm: number;
  onGenerated: (result: AiComposeResult) => void;
}> = ({ currentBpm, onGenerated }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [keyName, setKeyName] = useState('C');
  const [mode, setMode] = useState('minor');
  const [style, setStyle] = useState('None');
  const [bars, setBars] = useState(8);
  const [bpm, setBpm] = useState(currentBpm || 120);
  const [complexity, setComplexity] = useState(0.6);
  const [withBass, setWithBass] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const generate = async () => {
    setBusy(true);
    try {
      const result = await generatePianoFromParams({
        prompt,
        key: keyName,
        mode,
        bars,
        bpm,
        style: style === 'None' ? undefined : style,
        complexity,
        withBass,
      });
      onGenerated(result);
      logInfo(
        'piano-roll',
        `AI composed ${result.notes.length} notes in ${keyName} ${mode}${result.summary ? ` — ${result.summary}` : ''}`,
      );
      setOpen(false);
    } catch (e) {
      logError('piano-roll', `AI compose failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="piano-roll-ai-compose-popover"
        className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
        title="Generate a piano part with AI from parameters"
      >
        <Sparkles className="w-3 h-3 text-emerald-300" /> AI COMPOSE
      </button>

      {open && (
        <div
          id="piano-roll-ai-compose-popover"
          role="dialog"
          aria-label="AI compose parameters"
          className="absolute right-0 top-full mt-1 z-50 w-72 bg-[#0a080f] border border-white/10 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.75)] p-2.5 flex flex-col gap-2"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-compose-prompt" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
              Describe the piece
            </label>
            <textarea
              id="ai-compose-prompt"
              name="ai-compose-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="e.g. dramatic minor-key intro that builds to virtuosic runs"
              className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 outline-none resize-none focus:border-emerald-500/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="ai-compose-key" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                Key
              </label>
              <select
                id="ai-compose-key"
                name="ai-compose-key"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="bg-black/60 border border-white/10 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-emerald-500/40"
              >
                {KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="ai-compose-mode" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                Mode
              </label>
              <select
                id="ai-compose-mode"
                name="ai-compose-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="bg-black/60 border border-white/10 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-emerald-500/40"
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="ai-compose-bars" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                Bars
              </label>
              <input
                id="ai-compose-bars"
                name="ai-compose-bars"
                type="number"
                min={1}
                max={32}
                value={bars}
                onChange={(e) => setBars(Math.max(1, Math.min(32, parseInt(e.target.value) || 8)))}
                className="bg-black/60 border border-white/10 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-emerald-500/40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="ai-compose-bpm" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                BPM
              </label>
              <input
                id="ai-compose-bpm"
                name="ai-compose-bpm"
                type="number"
                min={40}
                max={240}
                value={bpm}
                onChange={(e) => setBpm(Math.max(40, Math.min(240, parseInt(e.target.value) || 120)))}
                className="bg-black/60 border border-white/10 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-emerald-500/40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="ai-compose-style" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                Style
              </label>
              <select
                id="ai-compose-style"
                name="ai-compose-style"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className="bg-black/60 border border-white/10 rounded px-1.5 py-1 text-[10px] text-zinc-200 outline-none focus:border-emerald-500/40"
              >
                {STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="ai-compose-complexity" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500 shrink-0">
              Density
            </label>
            <input
              id="ai-compose-complexity"
              name="ai-compose-complexity"
              type="range"
              min={0}
              max={100}
              value={Math.round(complexity * 100)}
              onChange={(e) => setComplexity((parseInt(e.target.value) || 0) / 100)}
              className="flex-1 accent-emerald-400"
            />
            <span className="text-[9px] font-mono text-emerald-300 w-8 text-right">
              {Math.round(complexity * 100)}%
            </span>
          </div>

          <label htmlFor="ai-compose-bass" className="flex items-center gap-2 text-[10px] text-zinc-300 cursor-pointer">
            <input
              id="ai-compose-bass"
              name="ai-compose-bass"
              type="checkbox"
              checked={withBass}
              onChange={(e) => setWithBass(e.target.checked)}
              className="accent-emerald-400"
            />
            Distinct left-hand bass line
          </label>

          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy}
            className="w-full mt-0.5 flex items-center justify-center gap-2 px-2 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-[10px] font-black uppercase tracking-widest text-emerald-200 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            {busy ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Composing…
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" /> Generate to roll
              </>
            )}
          </button>
          <p className="text-[8px] font-mono text-zinc-600 leading-tight">
            Replaces the roll with the generated part. Needs a Gemini API key set in Settings.
          </p>
        </div>
      )}
    </div>
  );
};
