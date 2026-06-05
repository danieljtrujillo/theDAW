/**
 * Renders a user-created control (a `CustomWidgetDef`) inside a WidgetCell. In
 * 'control' mode it draws the chosen kind (knob / fader / toggle / pad /
 * crossfader) styled by the def's tint, holds the value locally, and pushes
 * every change straight to the bound `BindableTarget.invoke` — so a control the
 * user dropped in is wired to the backend with no extra code. In 'visualizer'
 * mode it embeds a live visualizer.
 */
import React, { useState } from 'react';
import { Power } from 'lucide-react';
import { SlideKnob } from '../audio/SlideKnob';
import { SlideFader } from '../audio/SlideFader';
import { SlidePad } from '../audio/SlidePad';
import { SlideCrossfader } from '../audio/SlideCrossfader';
import { RoundToggle } from '../audio/RoundToggle';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { colorAt } from '../../lib/trackColor';
import type { BindableTarget, CustomWidgetDef, WidgetSize } from './widgetTypes';

const initialValue = (def: CustomWidgetDef, target?: BindableTarget): number | boolean => {
  if (def.kind === 'toggle') return false;
  if (def.kind === 'crossfader') return 0;
  const min = target?.min ?? 0;
  const max = target?.max ?? 1;
  return min < 0 && max > 0 ? 0 : min; // bipolar → centre; else → min
};

export const CustomControl: React.FC<{
  def: CustomWidgetDef;
  targets: BindableTarget[];
  size: WidgetSize;
  /** Per-widget shape override (the Design-Mode shape grip); falls back to the
   *  shape chosen when the control was created. */
  shapeOverride?: import('./widgetTypes').ButtonShape;
}> = ({ def, targets, size, shapeOverride }) => {
  const target = def.targetId ? targets.find((t) => t.id === def.targetId) : undefined;
  const [val, setVal] = useState<number | boolean>(() => initialValue(def, target));
  const push = (v: number | boolean) => {
    setVal(v);
    target?.invoke(v);
  };

  if (def.mode === 'visualizer') {
    return (
      <div className="h-full w-full min-h-0 min-w-0 overflow-hidden rounded">
        <AdvancedVisualizer />
      </div>
    );
  }

  // Unbound control (target missing) still renders so the user can re-bind it.
  const min = target?.min ?? 0;
  const max = target?.max ?? 1;
  const step = target?.step;
  const dim = Math.max(20, Math.min(size.w, size.h));

  switch (def.kind) {
    case 'fader':
      return (
        <div className="h-full min-h-0 flex justify-center">
          <SlideFader label={def.label} value={Number(val)} onChange={push} min={min} max={max} step={step} tint={def.tint} />
        </div>
      );
    case 'crossfader':
      return <SlideCrossfader value={Number(val)} min={min} max={max} onChange={push} />;
    case 'toggle':
      return <RoundToggle label={def.label} icon={Power} on={Boolean(val)} onChange={push} box={Math.min(dim, 46)} />;
    case 'pad':
      return (
        <SlidePad color={colorAt(def.tint ?? 0.7)} shape={shapeOverride ?? def.shape} onClick={() => target?.invoke(true)} className="px-3 py-1" title={def.label}>
          {def.label}
        </SlidePad>
      );
    case 'knob':
    default:
      return (
        <SlideKnob
          label={def.label}
          value={Number(val)}
          onChange={push}
          min={min}
          max={max}
          step={step}
          size={Math.min(dim, 56)}
          center={min < 0 && max > 0}
          centerReadout
          tint={def.tint}
        />
      );
  }
};
