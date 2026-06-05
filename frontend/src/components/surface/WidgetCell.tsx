/**
 * Hosts one placed widget. Measures its cell with a ResizeObserver and hands
 * the pixel size to the widget's `render` closure (the closure decides how to
 * fit each control kind). The live control stays fully interactive; widget
 * relocation happens through a small grip handle (a WIDGET_MIME drag source),
 * never the whole cell, so dragging a knob adjusts the knob rather than moving
 * the widget. The cell is also a drop target: dropping a widget onto it inserts
 * at this index.
 *
 * Fill mode ('scale' vs 'natural'), per-widget justify, and panel mirror are
 * applied here and forwarded into the widget's render opts.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, X, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { WIDGET_MIME, encode, decodeWidget } from './dnd';
import { useLayoutPrefs } from '../../state/layoutPrefsStore';
import { isSpacer } from '../../state/surfaceLayoutStore';
import type { WidgetId } from './widgetTypes';
import type { NodeId } from '../../state/surfaceLayoutStore';

type Justify = 'start' | 'center' | 'end';

interface Props {
  widgetId: WidgetId;
  panelId: NodeId;
  index: number;
  design: boolean;
  justify?: Justify;
  mirror?: boolean;
}

const JUSTIFY_CLASS: Record<Justify, string> = {
  start: 'justify-items-start',
  center: 'justify-items-center',
  end: 'justify-items-end',
};
const JUSTIFY_ICON: Record<Justify, React.ComponentType<{ className?: string }>> = {
  start: AlignLeft,
  center: AlignCenter,
  end: AlignRight,
};

// Cap a control's size in 'natural' (compact) fill mode so dead space appears
// and the control can be justified within the cell.
const NATURAL_CAP = 60;

// Deliberately NOT memoized: the host tab rebuilds its registry (with fresh
// closures carrying live values) on each render, so the cell must re-render
// with the surface to reflect live control state.
export const WidgetCell: React.FC<Props> = ({ widgetId, panelId, index, design, justify = 'center', mirror }) => {
  const { surfaceId, store, registry } = useSurface();
  const fillMode = useLayoutPrefs((s) => s.fillMode);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const def = registry[widgetId];
  const spacer = isSpacer(widgetId);
  const label = def?.label ?? (spacer ? 'Spacer' : widgetId);
  const acceptDrop = (e: React.DragEvent) => design && e.dataTransfer.types.includes(WIDGET_MIME);

  const fill = fillMode === 'scale';
  const effSize = fill ? size : { w: Math.min(size.w, NATURAL_CAP), h: Math.min(size.h, NATURAL_CAP) };
  const JustIcon = JUSTIFY_ICON[justify];

  return (
    <div
      ref={ref}
      className={`relative min-w-0 min-h-0 h-full w-full grid items-center ${JUSTIFY_CLASS[justify]} ${over ? 'ring-2 ring-inset ring-emerald-300/80 rounded' : ''}`}
      onDragOver={
        design
          ? (e) => {
              if (!acceptDrop(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOver(true);
            }
          : undefined
      }
      onDragLeave={design ? () => setOver(false) : undefined}
      onDrop={
        design
          ? (e) => {
              setOver(false);
              if (!acceptDrop(e)) return;
              const p = decodeWidget(e.dataTransfer.getData(WIDGET_MIME));
              if (!p || p.surfaceId !== surfaceId) return;
              e.preventDefault();
              e.stopPropagation();
              store.getState().moveWidget(p.widgetId, panelId, index);
            }
          : undefined
      }
    >
      {def ? (
        def.render(effSize, { mirror, justify, fill })
      ) : spacer ? (
        design ? (
          <div className="w-full h-full border border-dashed border-white/15 rounded grid place-items-center">
            <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-600">spacer</span>
          </div>
        ) : null
      ) : (
        <span className="text-[8px] font-mono text-rose-400/70" title={`Unknown widget: ${widgetId}`}>?</span>
      )}

      {design && (
        <>
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(WIDGET_MIME, encode({ surfaceId, widgetId, fromPanelId: panelId }));
            }}
            title={`Move ${label}`}
            className="absolute top-0 left-0 z-50 h-3.5 w-3.5 grid place-items-center rounded-br bg-purple-600/85 hover:bg-purple-500 cursor-grab active:cursor-grabbing"
          >
            <GripVertical className="w-2.5 h-2.5 text-purple-50" />
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              store.getState().cycleWidgetJustify(panelId, widgetId);
            }}
            title={`Justify: ${justify} (click to cycle)`}
            className="absolute top-0 left-4 z-50 h-3.5 w-3.5 grid place-items-center rounded-b bg-cyan-600/80 hover:bg-cyan-500 text-cyan-50"
          >
            <JustIcon className="w-2.5 h-2.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              store.getState().removeWidget(widgetId);
            }}
            title={`Remove ${label} (back to palette)`}
            className="absolute top-0 right-0 z-50 h-3.5 w-3.5 grid place-items-center rounded-bl bg-rose-600/80 hover:bg-rose-500 text-rose-50"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </>
      )}
    </div>
  );
};
