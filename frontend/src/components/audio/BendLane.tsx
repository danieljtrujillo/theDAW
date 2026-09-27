/**
 * The pitch bend lane: the strip under the piano roll where a lane's bend is
 * drawn and edited, and the row of controls that goes with it.
 *
 * The engine has carried pitch bend since it landed — the roll model, the MIDI
 * file both ways, the live soundfont, the arp and Vocal2MIDI all read it — but
 * nothing on screen could put a point on a curve. This is that surface.
 *
 * The strip shares the grid's x scale, so a point sits under the note it bends,
 * and scrolls with the grid because it lives inside the same scroll box. Its y
 * scale is the lane's own: the top is the lane's full range up, the centre line
 * is no bend, the bottom is the full range down. The range in semitones is the
 * RANGE field, so the same curve is a whole-tone scoop at 2 and a dive at 12.
 *
 * Editing, all of it on the active lane (the one new notes go into):
 *   - a click on empty strip adds a point there
 *   - a drag moves a point; the step snaps to the grid and the value to the
 *     centre, the half-range marks and the extremes, and Alt takes both free
 *   - a click on a point selects it; SHAPE cycles what the curve does after it
 *     (LINE ramps, HOLD jumps at the next point, CURVE eases)
 *   - Delete, Backspace or an Alt-click removes the selected point
 *   - the arrow keys move the selected point, Shift for a coarse step
 *   - CLEAR empties the lane, and its range stays
 *
 * A lane that has no points takes none once MAX_BENT_LANES lanes already bend:
 * a pitch wheel bends a whole MIDI channel, so there is a hard limit on how many
 * lanes can have their own. The strip says so rather than dropping the click.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Minus, Plus } from 'lucide-react';
import { beginRollGesture, endRollGesture, usePianoRollStore } from '../../state/pianoRollStore';
import { barAt } from '../../lib/meterMap';
import {
  BEND_LANE_HEIGHT,
  BEND_POINT_R,
  BEND_SHAPE_LABEL,
  BEND_SHAPE_TITLE,
  bendPath,
  bendPointAt,
  bendValueToY,
  bendYToValue,
  nextBendShape,
  snapBendStep,
  snapBendValue,
} from '../../lib/bendLane';
import {
  DEFAULT_BEND_RANGE,
  MAX_BENT_LANES,
  MAX_BEND_RANGE,
  bendCents,
  type BendPoint,
} from '../../lib/pitchBend';
import { FIELD, FIELD_LEGEND, FIELD_VALUE, MINI_GLYPH, MINI_ICON_KEY, StripKey } from './midiDockKit';

/** The step a key press moves a point by, and the coarse step under Shift. */
const KEY_STEP = 1;
const KEY_STEP_COARSE = 4;
/** The value a key press moves a point by, and the coarse step under Shift. */
const KEY_VALUE = 0.05;
const KEY_VALUE_COARSE = 0.25;

/** A point's value as a reading: semitones and cents at the lane's range. */
export function bendReading(value: number, range: number): string {
  const cents = bendCents(value, range);
  if (Math.abs(cents) < 0.5) return 'centre';
  const semis = cents / 100;
  const sign = cents > 0 ? '+' : '−';
  return `${sign}${Math.abs(semis).toFixed(2)} st`;
}

interface BendLaneProps {
  /** Grid px per step, shared with the roll so a point sits under its note. */
  stepPx: number;
  totalSteps: number;
  /** Steps a point snaps to (1 = a 16th). */
  quantum?: number;
}

export const BendLane: React.FC<BendLaneProps> = ({ stepPx, totalSteps, quantum = 1 }) => {
  const activeLane = usePianoRollStore((s) => s.activeLane);
  const bends = usePianoRollStore((s) => s.bends);
  const lanes = usePianoRollStore((s) => s.lanes);
  const addBendPoint = usePianoRollStore((s) => s.addBendPoint);
  const moveBendPoint = usePianoRollStore((s) => s.moveBendPoint);
  const removeBendPoint = usePianoRollStore((s) => s.removeBendPoint);
  const clearBend = usePianoRollStore((s) => s.clearBend);
  const setBendRange = usePianoRollStore((s) => s.setBendRange);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const bend = bends.find((b) => b.lane === activeLane) ?? null;
  const points: readonly BendPoint[] = bend?.points ?? [];
  const range = bend?.range ?? DEFAULT_BEND_RANGE;
  const laneName = useMemo(() => {
    const i = lanes.findIndex((l) => l.id === activeLane);
    return i < 0 ? 'A' : String.fromCharCode(65 + i);
  }, [lanes, activeLane]);

  /** Lanes that already bend, and whether this one may start. */
  const bentLanes = bends.filter((b) => b.points.length > 0).length;
  const full = points.length === 0 && bentLanes >= MAX_BENT_LANES;

  const selected = points.find((p) => p.id === selectedId) ?? null;
  // A point removed under the selection, or a lane change, drops it.
  useEffect(() => {
    if (selectedId && !points.some((p) => p.id === selectedId)) setSelectedId(null);
  }, [points, selectedId]);
  useEffect(() => setSelectedId(null), [activeLane]);
  // The lane closed under a drag: the drag's undo step ends with it, so the
  // next edit anywhere in the roll is a step of its own.
  useEffect(
    () => () => {
      if (dragRef.current) endRollGesture();
    },
    [],
  );

  const width = Math.max(1, totalSteps * stepPx);
  const height = BEND_LANE_HEIGHT;
  const d = useMemo(() => bendPath(points, { stepPx, totalSteps, height }), [points, stepPx, totalSteps, height]);

  const localPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const r = surfaceRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    const hit = bendPointAt(points, x, y, { stepPx, height });
    // Alt on a point removes it; Alt on empty strip is the free-placement drag.
    if (hit && e.altKey) {
      removeBendPoint(activeLane, hit.id);
      setSelectedId(null);
      e.preventDefault();
      return;
    }
    // Placing a point and dragging it is one undo step, however long the drag pauses.
    beginRollGesture();
    const id =
      hit?.id ??
      addBendPoint(activeLane, {
        step: snapBendStep(x, stepPx, totalSteps, quantum, e.altKey),
        value: snapBendValue(bendYToValue(y, height), e.altKey),
        shape: 'linear',
      });
    if (!id) {
      endRollGesture();
      return; // no channel left for this lane
    }
    setSelectedId(id);
    dragRef.current = { id, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = localPoint(e);
    dragRef.current = { ...drag, moved: true };
    moveBendPoint(activeLane, drag.id, {
      step: snapBendStep(x, stepPx, totalSteps, quantum, e.altKey),
      value: snapBendValue(bendYToValue(y, height), e.altKey),
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    endRollGesture();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const nudge = useCallback(
    (dStep: number, dValue: number) => {
      if (!selected) return;
      moveBendPoint(activeLane, selected.id, {
        step: Math.max(0, Math.min(totalSteps, selected.step + dStep)),
        value: snapBendValue(selected.value + dValue, true),
      });
    },
    [activeLane, moveBendPoint, selected, totalSteps],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    const value = e.shiftKey ? KEY_VALUE_COARSE : KEY_VALUE;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': nudge(-step, 0); break;
      case 'ArrowRight': nudge(step, 0); break;
      case 'ArrowUp': nudge(0, value); break;
      case 'ArrowDown': nudge(0, -value); break;
      case 'Delete':
      case 'Backspace':
        if (selected) removeBendPoint(activeLane, selected.id);
        break;
      case 'Home':
        if (points[0]) setSelectedId(points[0].id);
        break;
      case 'End':
        if (points.length) setSelectedId(points[points.length - 1].id);
        break;
      case 'Tab':
        handled = false;
        break;
      default:
        handled = false;
    }
    // The roll and the window share these keys; a handled one stops here.
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const cycleShape = () => {
    if (!selected) return;
    moveBendPoint(activeLane, selected.id, { shape: nextBendShape(selected.shape) });
  };

  const rangeId = `bend-range-${activeLane}`;
  // The strip is a slider over the selected point: its bend in semitones at
  // the lane's range, or the centre with none picked.
  const pointSemis = selected ? Math.round(bendCents(selected.value, range)) / 100 : 0;
  const pointText = selected
    ? (() => {
        const b = barAt(meterMap, Math.max(0, selected.step), pickupSteps);
        const where = b.bar < 0 ? 'the pickup' : `bar ${b.bar + 1}, step ${Math.round((selected.step - b.start) * 100) / 100 + 1}`;
        return `${bendReading(selected.value, range)} at ${where}, ${BEND_SHAPE_LABEL[selected.shape]}`;
      })()
    : 'No point selected';

  return (
    <div className="shrink-0 border-t border-white/8 bg-black/30" data-bend-lane>
      {/* The controls sit above the strip, left-aligned under the keyboard
          column's edge, so they read as this lane's row and not the roll's. */}
      <div className="h-6.5 flex items-center gap-1.5 px-1.5 border-b border-white/5">
        <span className={FIELD_LEGEND}>Bend {laneName}</span>

        <div className={FIELD}>
          <label htmlFor={rangeId} className={FIELD_LEGEND}>Range</label>
          <input
            id={rangeId}
            name={rangeId}
            type="number"
            min={0}
            max={MAX_BEND_RANGE}
            step={1}
            value={range}
            onChange={(e) => setBendRange(activeLane, Number(e.target.value))}
            title="How many semitones the top and bottom of the strip are worth"
            className="w-8 h-5 bg-transparent border-none outline-none text-[12px] font-bold et-ink tabular-nums"
          />
          <span className={FIELD_VALUE}>st</span>
        </div>

        <StripKey
          mini
          onClick={cycleShape}
          disabled={!selected}
          legend={selected ? BEND_SHAPE_LABEL[selected.shape] : 'LINE'}
          aria-label={selected ? `Shape of the selected point: ${BEND_SHAPE_LABEL[selected.shape]}` : 'Shape: select a point first'}
          description={selected ? BEND_SHAPE_TITLE[selected.shape] : 'Select a point to change what the curve does after it'}
        />

        <span className={FIELD_VALUE} title="The selected point">
          {selected ? bendReading(selected.value, range) : '—'}
        </span>

        <span className="flex-1" />

        <StripKey
          mini
          iconOnly
          onClick={() => setBendRange(activeLane, Math.max(0, range - 1))}
          icon={<Minus className={MINI_GLYPH} />}
          legend="Range down"
          className={MINI_ICON_KEY}
        />
        <StripKey
          mini
          iconOnly
          onClick={() => setBendRange(activeLane, Math.min(MAX_BEND_RANGE, range + 1))}
          icon={<Plus className={MINI_GLYPH} />}
          legend="Range up"
          className={MINI_ICON_KEY}
        />
        <StripKey
          mini
          iconOnly
          onClick={() => { clearBend(activeLane); setSelectedId(null); }}
          disabled={points.length === 0}
          icon={<Eraser className={MINI_GLYPH} />}
          legend="Clear bend"
          description={`Remove every point on lane ${laneName}; its range stays`}
          className={MINI_ICON_KEY}
        />
      </div>

      {/* The strip: a slider whose value is the selected point's bend in
          semitones. The arrow keys move that point (up and down its bend, left
          and right its step), and a screen reader announces the bend and where. */}
      <div
        ref={surfaceRef}
        role="slider"
        tabIndex={0}
        aria-label={`Pitch bend for lane ${laneName}, ${points.length} point${points.length === 1 ? '' : 's'}, range ${range} semitones`}
        aria-valuemin={-range}
        aria-valuemax={range}
        aria-valuenow={pointSemis}
        aria-valuetext={pointText}
        aria-describedby="bend-lane-help"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className="relative cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-accent))]"
        style={{ width, height }}
      >
        <svg
          width={width}
          height={height}
          className="absolute inset-0 pointer-events-none"
          shapeRendering="geometricPrecision"
        >
          {/* The centre line and the half-range marks the drag snaps to. */}
          {[1, 0.5, 0, -0.5, -1].map((v) => (
            <line
              key={v}
              x1={0}
              x2={width}
              y1={bendValueToY(v, height)}
              y2={bendValueToY(v, height)}
              stroke={v === 0 ? 'rgb(255 255 255 / 0.22)' : 'rgb(255 255 255 / 0.07)'}
              strokeWidth={1}
            />
          ))}
          <path d={d} fill="none" stroke="rgb(var(--et-accent))" strokeWidth={1.5} />
          {points.map((p) => (
            <circle
              key={p.id}
              cx={p.step * stepPx}
              cy={bendValueToY(p.value, height)}
              r={p.id === selectedId ? BEND_POINT_R + 1.5 : BEND_POINT_R}
              fill={p.id === selectedId ? 'rgb(var(--et-accent))' : 'rgb(10 8 15)'}
              stroke="rgb(var(--et-accent))"
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {full && (
          <p className="absolute inset-0 flex items-center justify-start pl-2 text-[12px] font-semibold et-ink-2 pointer-events-none">
            {MAX_BENT_LANES} lanes already bend, which is every MIDI channel there is for it. Clear one to bend lane {laneName}.
          </p>
        )}
      </div>
      <p id="bend-lane-help" className="sr-only">
        Click to add a point, drag to move it, Alt-click to remove it. Alt while dragging places it off the grid.
        The arrow keys move the selected point, Shift for a coarser step, Delete removes it. Home and End select
        the first and last point.
      </p>
    </div>
  );
};
