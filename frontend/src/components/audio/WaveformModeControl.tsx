/**
 * The waveform colour mode's control and its legend, shared by every surface
 * that shows a SemanticWave / DJSemanticWaveform.
 *
 * The mode is one global preference (`state/waveformStyleStore`). The toggle
 * cycles it; the legend lists what each colour means in the current mode,
 * read from `WAVEFORM_LEGEND` next to the drawing code, so the words cannot
 * drift from the colours.
 *
 * Where it sits is the caller's call. `SemanticWave` puts the `corner` variant
 * over a plain waveform. A surface whose waveform carries edit handles (EDIT
 * clips, the clip editor drawer) renders the `toolbar` variant in its own
 * toolbar and hides the corner one, so no mode button ever sits over a trim
 * handle, a fade grip or a narrow clip's body.
 */
import React, { useId } from 'react';
import { WAVEFORM_LEGEND } from './djSemanticWaveformAnalysis';
import { useWaveformStyleStore, WAVEFORM_DRAW_MODES, type WaveformDrawMode } from '../../state/waveformStyleStore';

/** The mode's name as the control shows it. */
export const WAVEFORM_MODE_NAME: Record<WaveformDrawMode, string> = {
  semantic: 'Color',
  plain: 'Plain',
  clipping: 'Clipping',
};

const MODE_GLYPH: Record<WaveformDrawMode, string> = { semantic: '●', plain: '○', clipping: '!' };

function nextMode(mode: WaveformDrawMode): WaveformDrawMode {
  const i = WAVEFORM_DRAW_MODES.indexOf(mode);
  return WAVEFORM_DRAW_MODES[(i + 1) % WAVEFORM_DRAW_MODES.length];
}

/** The legend as one sentence, for a tooltip or an accessible name. */
export function waveformLegendText(mode: WaveformDrawMode): string {
  return WAVEFORM_LEGEND[mode].map((item) => item.label).join('; ');
}

export interface WaveformModeToggleProps {
  /** `corner`: a small round button pinned to the bottom-right of the
   *  positioned parent. `toolbar`: an inline glyph button for a toolbar. */
  variant: 'corner' | 'toolbar';
  className?: string;
}

export const WaveformModeToggle: React.FC<WaveformModeToggleProps> = ({ variant, className }) => {
  const mode = useWaveformStyleStore((s) => s.mode);
  const cycleMode = useWaveformStyleStore((s) => s.cycleMode);
  const next = WAVEFORM_MODE_NAME[nextMode(mode)];
  // Starts with the mode's name, so a voice-control user who says "click
  // Wave Color" reaches the button.
  const label = `Wave: ${WAVEFORM_MODE_NAME[mode]}. Waveform colors: ${waveformLegendText(mode)}. Press for ${next}.`;
  const base =
    'font-sans text-xs font-bold leading-none transition-colors focus-visible:outline focus-visible:outline-purple-400';
  const look =
    variant === 'corner'
      ? 'absolute bottom-0.5 right-0.5 z-40 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/60 px-1 text-white/70 hover:text-white'
      : 'flex h-6 w-6 items-center justify-center rounded text-zinc-300 hover:bg-white/5 hover:text-white';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        cycleMode();
      }}
      className={`${base} ${look} ${className ?? ''}`}
    >
      {/* Glyph only on every surface — the mode's name and legend live in the
          accessible label and tooltip, so the toolbar stays icon-dense. */}
      <span aria-hidden="true">{MODE_GLYPH[mode]}</span>
    </button>
  );
};

/** The colours of the current mode, each with what it means. */
export const WaveformModeLegend: React.FC<{ className?: string }> = ({ className }) => {
  const mode = useWaveformStyleStore((s) => s.mode);
  const headingId = useId();
  return (
    <div className={`flex min-w-0 items-center gap-2 overflow-hidden font-sans text-xs font-bold ${className ?? ''}`}>
      <span id={headingId} className="shrink-0 text-zinc-400">
        {WAVEFORM_MODE_NAME[mode]}:
      </span>
      <ul aria-labelledby={headingId} className="flex min-w-0 items-center gap-3 overflow-hidden">
        {WAVEFORM_LEGEND[mode].map((item) => (
          <li key={item.label} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-zinc-300">
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-sm"
              style={{ background: `rgb(${item.rgb[0]}, ${item.rgb[1]}, ${item.rgb[2]})` }}
            />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
};
