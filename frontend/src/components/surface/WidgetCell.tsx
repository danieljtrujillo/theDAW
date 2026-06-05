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
import { CustomControl } from './CustomControl';
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
  uniform?: boolean;
  margins?: { t: number; r: number; b: number; l: number };
}

type Side = 't' | 'r' | 'b' | 'l';

/** A draggable edge handle that sets one side's margin. Snaps to `snapPx`
 *  (0 = off); hold Ctrl while dragging for a 1px fine step. Shows a live px
 *  label while dragging. */
const MarginHandle: React.FC<{
  side: Side;
  value: number;
  snapPx: number;
  onSet: (px: number) => void;
  onDragState: (active: boolean) => void;
}> = ({ side, value, snapPx, onSet, onDragState }) => {
  const drag = useRef(false);
  const startPos = useRef(0);
  const startVal = useRef(0);
  const [lbl, setLbl] = useState<number | null>(null);
  const axisY = side === 't' || side === 'b';
  const sign = side === 't' || side === 'l' ? 1 : -1;
  const down = (e: React.PointerEvent) => {
    drag.current = true;
    startPos.current = axisY ? e.clientY : e.clientX;
    startVal.current = value;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
    onDragState(true);
    setLbl(value);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const cur = axisY ? e.clientY : e.clientX;
    const delta = (cur - startPos.current) * sign;
    const step = e.ctrlKey ? 1 : Math.max(1, snapPx);
    let next = Math.round((startVal.current + delta) / step) * step;
    next = Math.max(0, Math.min(64, next));
    onSet(next);
    setLbl(next);
  };
  const up = (e: React.PointerEvent) => {
    drag.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    onDragState(false);
    setLbl(null);
  };
  const pos =
    side === 't' ? 'top-0 left-0 right-0 h-1.5 cursor-row-resize'
      : side === 'b' ? 'bottom-0 left-0 right-0 h-1.5 cursor-row-resize'
        : side === 'l' ? 'left-0 top-0 bottom-0 w-1.5 cursor-col-resize'
          : 'right-0 top-0 bottom-0 w-1.5 cursor-col-resize';
  const name = side === 't' ? 'top' : side === 'b' ? 'bottom' : side === 'l' ? 'left' : 'right';
  return (
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      title={`Drag to set ${name} margin (Ctrl = fine)`}
      className={`absolute z-40 bg-amber-400/30 hover:bg-amber-300/70 ${pos}`}
    >
      {lbl != null && (
        <span className="absolute top-0 left-1 text-[7px] font-mono text-amber-100 bg-black/80 px-0.5 rounded pointer-events-none">{lbl}</span>
      )}
    </div>
  );
};

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
// One shared size for every control when a panel is in uniform mode.
const UNIFORM_CAP = 46;

// Deliberately NOT memoized: the host tab rebuilds its registry (with fresh
// closures carrying live values) on each render, so the cell must re-render
// with the surface to reflect live control state.
export const WidgetCell: React.FC<Props> = ({ widgetId, panelId, index, design, justify = 'center', mirror, uniform, margins }) => {
  const { surfaceId, store, registry, targets } = useSurface();
  const custom = store((s) => s.layout.customWidgets?.[widgetId]);
  const fillMode = useLayoutPrefs((s) => s.fillMode);
  const snapPx = useLayoutPrefs((s) => s.snapPx);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [over, setOver] = useState(false);
  const [hover, setHover] = useState(false);
  const [marginDragging, setMarginDragging] = useState(false);

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
  const label = def?.label ?? custom?.label ?? (spacer ? 'Spacer' : widgetId);
  const acceptDrop = (e: React.DragEvent) => design && e.dataTransfer.types.includes(WIDGET_MIME);

  // Uniform mode forces compact, equal-sized controls regardless of fill mode.
  const fill = uniform ? false : fillMode === 'scale';
  const cap = uniform ? UNIFORM_CAP : NATURAL_CAP;
  const effSize = fill ? size : { w: Math.min(size.w, cap), h: Math.min(size.h, cap) };
  const JustIcon = JUSTIFY_ICON[justify];
  const m = margins ?? { t: 0, r: 0, b: 0, l: 0 };
  const showMargins = design && (hover || marginDragging);

  return (
    <div
      ref={ref}
      className={`relative min-w-0 min-h-0 h-full w-full grid items-center ${JUSTIFY_CLASS[justify]} ${over ? 'ring-2 ring-inset ring-emerald-300/80 rounded' : ''}`}
      style={{ paddingTop: m.t, paddingRight: m.r, paddingBottom: m.b, paddingLeft: m.l }}
      onPointerEnter={design ? () => setHover(true) : undefined}
      onPointerLeave={design ? () => setHover(false) : undefined}
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
      ) : custom ? (
        <CustomControl def={custom} targets={targets} size={effSize} />
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

      {showMargins && (
        <>
          {(['t', 'r', 'b', 'l'] as const).map((side) => (
            <MarginHandle
              key={side}
              side={side}
              value={m[side]}
              snapPx={snapPx}
              onSet={(px) => store.getState().setWidgetMargin(panelId, widgetId, side, px)}
              onDragState={setMarginDragging}
            />
          ))}
        </>
      )}
    </div>
  );
};
