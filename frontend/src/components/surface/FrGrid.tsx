/**
 * Fractional CSS-grid row/column with draggable splitters in the gap tracks.
 * Generalizes the old DesignLayout `LayoutRow`: it interleaves `fr` tracks with
 * fixed GAP tracks; in Design Mode each gap holds a `Splitter` that transfers fr
 * between its two neighbours. Used both for the surface's container tree and for
 * the widget layout inside a panel.
 */
import React, { useRef } from 'react';
import { Splitter } from './Splitter';
import { GAP } from './dnd';
import { useLayoutPrefs } from '../../state/layoutPrefsStore';
import type { Axis } from '../../state/surfaceLayoutStore';

export const FrGrid: React.FC<{
  axis: Axis;
  ids: string[];
  fr: Record<string, number>;
  design: boolean;
  onResize: (leftId: string, rightId: string, frac: number) => void;
  renderItem: (id: string, index: number) => React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Gap (px) between tracks; defaults to the surface GAP constant. */
  gap?: number;
}> = ({ axis, ids, fr, design, onResize, renderItem, className, style, gap }) => {
  const ref = useRef<HTMLDivElement>(null);
  const snapPx = useLayoutPrefs((s) => s.snapPx);
  const tracks: string[] = [];
  const children: React.ReactNode[] = [];
  const gapPx = gap ?? GAP;

  ids.forEach((id, i) => {
    if (i > 0) {
      tracks.push(`${gapPx}px`);
      children.push(
        design ? (
          <Splitter
            key={`s-${id}`}
            axis={axis === 'row' ? 'x' : 'y'}
            snap={snapPx}
            onDelta={(dpx) => {
              const el = ref.current;
              const sz = el ? (axis === 'row' ? el.clientWidth : el.clientHeight) : 0;
              if (sz > 0) onResize(ids[i - 1], id, dpx / sz);
            }}
          />
        ) : (
          <div key={`s-${id}`} />
        ),
      );
    }
    tracks.push(`${fr[id] ?? 1}fr`);
    children.push(<React.Fragment key={id}>{renderItem(id, i)}</React.Fragment>);
  });

  const gridStyle: React.CSSProperties =
    axis === 'row'
      ? { display: 'grid', gridTemplateColumns: tracks.join(' '), minWidth: 0, minHeight: 0 }
      : { display: 'grid', gridTemplateRows: tracks.join(' '), minWidth: 0, minHeight: 0 };

  return (
    <div ref={ref} className={className} style={{ ...style, ...gridStyle }}>
      {children}
    </div>
  );
};
