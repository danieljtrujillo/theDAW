import React, { useRef } from 'react';
import { PLAY_ALONG_MODES, type PlayAlongMode } from '../../../../state/playAlongStore';

export interface ModeSwitchProps {
  allowed: PlayAlongMode[];
  value: PlayAlongMode;
  onChange: (mode: PlayAlongMode) => void;
  /** Muted hint after the radios, e.g. '7 staves — try STRIP'. */
  hint?: string;
}

const MODE_LABELS: Record<PlayAlongMode, string> = {
  page: 'PAGE',
  strip: 'STRIP',
  chords: 'CHORDS',
  highway: 'HIGHWAY',
};

const MODE_TITLES: Record<PlayAlongMode, string> = {
  page: 'Sheet music as pages',
  strip: 'One continuous staff line scrolling under a now-line',
  chords: 'Chord strip with diagrams',
  highway: 'Notes travelling toward a hit line',
};

const DISABLED_TITLES: Record<PlayAlongMode, string> = {
  page: 'Needs a sheet or tab artifact',
  strip: 'Needs a sheet or tab artifact',
  chords: 'Needs a library track',
  highway: 'Needs a sheet artifact or a note chart',
};

/** PAGE | STRIP | CHORDS | HIGHWAY as a radio group with roving tabindex:
 *  Tab lands on the selected mode, Left/Right move among the enabled ones. */
export const ModeSwitch: React.FC<ModeSwitchProps> = ({ allowed, value, onChange, hint }) => {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const enabled = PLAY_ALONG_MODES.filter((m) => allowed.includes(m));
  // The roving focus stop: the selected mode when it is enabled, else the
  // first enabled one, so the group is always reachable by keyboard.
  const focusStop: PlayAlongMode | null = enabled.includes(value) ? value : (enabled[0] ?? null);

  const moveSelection = (from: PlayAlongMode, dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = Math.max(0, enabled.indexOf(from));
    const next = enabled[(at + dir + enabled.length) % enabled.length];
    onChange(next);
    const idx = PLAY_ALONG_MODES.indexOf(next);
    buttonsRef.current[idx]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, mode: PlayAlongMode) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(mode, 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(mode, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (enabled[0]) onChange(enabled[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = enabled[enabled.length - 1];
      if (last) onChange(last);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <div role="radiogroup" aria-label="Score view mode" className="flex items-center gap-0.5 rounded border border-white/10 bg-black/30 p-0.5">
        {PLAY_ALONG_MODES.map((mode, i) => {
          const isAllowed = allowed.includes(mode);
          const checked = mode === value;
          return (
            <button
              key={mode}
              ref={(el) => { buttonsRef.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={!isAllowed}
              tabIndex={mode === focusStop ? 0 : -1}
              title={isAllowed ? MODE_TITLES[mode] : DISABLED_TITLES[mode]}
              onClick={() => { if (isAllowed) onChange(mode); }}
              onKeyDown={(e) => onKeyDown(e, mode)}
              className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                checked
                  ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-500/40'
                  : 'text-zinc-400 hover:text-zinc-100 border border-transparent'
              }`}
            >
              {MODE_LABELS[mode]}
            </button>
          );
        })}
      </div>
      {hint && <span className="text-[8px] font-mono text-zinc-500 truncate">{hint}</span>}
    </div>
  );
};

export default ModeSwitch;
