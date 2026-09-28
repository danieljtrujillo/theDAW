/**
 * The CC lane: the strip under the piano roll where one controller of the
 * part being edited is drawn and edited, and the row of controls that goes
 * with it. It sits beside the bend lane and works the same way.
 *
 * What it draws is the part's controller changes (RollTrack `controls`, the
 * model stage 3 gave parts for a file's pedal and expression), filtered to
 * the controller the CONTROLLER field names: modulation (1), volume (7), pan
 * (10), expression (11), the sustain pedal (64), brightness (74) or the reverb
 * send (91). Every edit rewrites that controller's changes alone (lib/ccLane
 * withControllerPoints), so the part's other controllers stay put, and the
 * part's changes play on PLAY, in EDIT, in every render and in both MIDI
 * writers because they are the same list the part always carried.
 *
 * Editing:
 *   - a click on empty strip adds a change there; a drag moves it. The tick
 *     snaps to the roll's grid, Alt takes it free
 *   - with DRAW on, a drag writes the curve it passes over (a change every
 *     64th where the value moves), which is how a swell is drawn
 *   - RAMP writes a straight ramp from the selected change to the next one
 *   - Delete, Backspace or an Alt-click removes the selected change; the
 *     arrow keys move it (Shift for a coarse step)
 *   - REC records a hardware controller while the roll plays: every change
 *     of a controller a part keeps is written at the playhead, and the pass
 *     lands in one undo step when PLAY stops or REC goes off
 *   - CLEAR removes every change of this controller from the part
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Eraser, PenLine, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { activeTrackOf, beginRollGesture, endRollGesture, usePianoRollStore } from '../../state/pianoRollStore';
import { subscribeToMidi } from '../../state/midiBus';
import { clientToLocal } from '../../lib/canvasScale';
import { parseMidiMessage } from '../../lib/midiCapture';
import { barAt } from '../../lib/meterMap';
import { cellTicks, rollSnapDef, TICKS_PER_STEP } from '../../lib/rollSnap';
import { partController } from '../../lib/rollTracks';
import {
  CC_DRAW_TICKS,
  CC_LANE_CONTROLLERS,
  CC_LANE_HEIGHT,
  CC_POINT_R,
  DEFAULT_CC_LANE_CONTROLLER,
  ccLabel,
  ccPath,
  ccPointAt,
  ccTickAt,
  ccValueToY,
  ccYToValue,
  controllerPoints,
  moveCcPoint,
  rampPoints,
  recordCcPoint,
  removeCcPoint,
  replaceCcSpan,
  setCcPoint,
  withControllerPoints,
  type CcPoint,
} from '../../lib/ccLane';
import { FIELD, FIELD_LEGEND, FIELD_SELECT, FIELD_VALUE, MINI_GLYPH, MINI_ICON_KEY, STRIP_GLYPH, StripKey } from './midiDockKit';

/** The ticks a key press moves a change by, and under Shift. */
const KEY_TICKS = TICKS_PER_STEP;
const KEY_TICKS_COARSE = TICKS_PER_STEP * 4;
/** The value a key press moves a change by, and under Shift. */
const KEY_VALUE = 1;
const KEY_VALUE_COARSE = 8;

interface CcLaneProps {
  /** Grid px per step, shared with the roll so a change sits under its note. */
  stepPx: number;
  totalSteps: number;
}

export const CcLane: React.FC<CcLaneProps> = ({ stepPx, totalSteps }) => {
  const part = usePianoRollStore((s) => activeTrackOf(s));
  const setTrackControls = usePianoRollStore((s) => s.setTrackControls);
  const snap = usePianoRollStore((s) => s.snap);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);

  const [controller, setController] = useState<number>(DEFAULT_CC_LANE_CONTROLLER);
  const [selectedTick, setSelectedTick] = useState<number | null>(null);
  const [draw, setDraw] = useState(false);
  const [rec, setRec] = useState(false);
  /** A REC pass's changes by controller, shown over the strip until the pass lands. */
  const [recorded, setRecorded] = useState<ReadonlyMap<number, CcPoint[]>>(new Map());
  const recordedRef = useRef(new Map<number, { points: CcPoint[]; last: number | null }>());

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ tick: number; mode: 'move' | 'draw'; lastTick: number; lastValue: number } | null>(null);

  const totalTicks = Math.max(1, totalSteps * TICKS_PER_STEP);
  const snapTicks = cellTicks(rollSnapDef(snap)) || TICKS_PER_STEP;
  const stored = useMemo(() => controllerPoints(part.controls, controller), [part.controls, controller]);
  const points = recorded.get(controller) ?? stored;
  const selected = points.find((p) => p.tick === selectedTick) ?? null;
  const info = partController(controller);
  const width = Math.max(1, totalSteps * stepPx);
  const height = CC_LANE_HEIGHT;
  const geo = useMemo(() => ({ stepPx, ticksPerStep: TICKS_PER_STEP, totalTicks, height }), [stepPx, totalTicks, height]);
  const d = useMemo(() => ccPath(points, controller, geo), [points, controller, geo]);

  // The part, the controller or the list changed under the selection: it goes when its change does.
  useEffect(() => {
    if (selectedTick !== null && !stored.some((p) => p.tick === selectedTick)) setSelectedTick(null);
  }, [stored, selectedTick]);
  useEffect(() => setSelectedTick(null), [part.id, controller]);
  // The lane closed under a drag: the drag's undo step ends with it.
  useEffect(
    () => () => {
      if (dragRef.current) endRollGesture();
    },
    [],
  );

  /** Write this controller's changes into the part. */
  const write = useCallback(
    (next: readonly CcPoint[]) => {
      const s = usePianoRollStore.getState();
      const t = activeTrackOf(s);
      setTrackControls(t.id, withControllerPoints(t.controls, controller, next) ?? null);
    },
    [controller, setTrackControls],
  );

  // ── REC: a hardware controller, written at the playhead while the roll plays ──
  const landRecording = useCallback(() => {
    const pass = recordedRef.current;
    recordedRef.current = new Map();
    setRecorded(new Map());
    if (!pass.size) return;
    const s = usePianoRollStore.getState();
    const t = activeTrackOf(s);
    let controls = t.controls;
    for (const [cc, r] of pass) controls = withControllerPoints(controls, cc, r.points);
    setTrackControls(t.id, controls ?? null);
  }, [setTrackControls]);

  useEffect(() => {
    if (!rec) return undefined;
    const off = subscribeToMidi((msg) => {
      const m = parseMidiMessage(msg.data);
      if (m.kind !== 'cc' || !CC_LANE_CONTROLLERS.includes(m.note)) return;
      const s = usePianoRollStore.getState();
      if (!s.isPlaying) return;
      const tick = Math.round(s.currentStep * TICKS_PER_STEP);
      const pass = recordedRef.current;
      const was = pass.get(m.note) ?? { points: controllerPoints(activeTrackOf(s).controls, m.note), last: null };
      const points = recordCcPoint(was.points, m.note, tick, m.velocity, was.last);
      pass.set(m.note, { points, last: tick });
      setRecorded(new Map([...pass].map(([cc, r]) => [cc, r.points])));
    });
    return off;
  }, [rec]);
  // A pass lands when PLAY stops or REC goes off.
  useEffect(() => {
    if (!isPlaying) landRecording();
  }, [isPlaying, landRecording]);
  useEffect(() => {
    if (!rec) landRecording();
  }, [rec, landRecording]);

  const localPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const el = surfaceRef.current;
    return el ? clientToLocal(el, e.clientX, e.clientY) : { x: e.clientX, y: e.clientY };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    const hit = ccPointAt(points, x, y, geo);
    if (hit && e.altKey) {
      write(removeCcPoint(points, hit.tick));
      setSelectedTick(null);
      e.preventDefault();
      return;
    }
    // A change placed and dragged, or a curve drawn, is one undo step.
    beginRollGesture();
    const tick = ccTickAt(x, stepPx, TICKS_PER_STEP, totalTicks, draw ? CC_DRAW_TICKS : snapTicks, e.altKey);
    const value = ccYToValue(y, height);
    if (draw && !hit) {
      dragRef.current = { tick, mode: 'draw', lastTick: tick, lastValue: value };
      write(setCcPoint(points, tick, value));
      setSelectedTick(tick);
    } else {
      const at = hit?.tick ?? tick;
      if (!hit) write(setCcPoint(points, tick, value));
      setSelectedTick(at);
      dragRef.current = { tick: at, mode: 'move', lastTick: at, lastValue: hit?.value ?? value };
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = localPoint(e);
    const value = ccYToValue(y, height);
    const current = controllerPoints(activeTrackOf(usePianoRollStore.getState()).controls, controller);
    if (drag.mode === 'draw') {
      const tick = ccTickAt(x, stepPx, TICKS_PER_STEP, totalTicks, CC_DRAW_TICKS, e.altKey);
      if (tick === drag.lastTick && value === drag.lastValue) return;
      const span = rampPoints(drag.lastTick, drag.lastValue, tick, value);
      write(replaceCcSpan(current, drag.lastTick, tick, span));
      dragRef.current = { ...drag, lastTick: tick, lastValue: value };
      return;
    }
    const tick = ccTickAt(x, stepPx, TICKS_PER_STEP, totalTicks, snapTicks, e.altKey);
    write(moveCcPoint(current, drag.tick, tick, value));
    dragRef.current = { ...drag, tick, lastTick: tick, lastValue: value };
    setSelectedTick(tick);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    endRollGesture();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const nudge = (dTick: number, dValue: number) => {
    if (!selected) return;
    const tick = Math.max(0, Math.min(totalTicks, selected.tick + dTick));
    write(moveCcPoint(points, selected.tick, tick, selected.value + dValue));
    setSelectedTick(tick);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    const dt = e.shiftKey ? KEY_TICKS_COARSE : KEY_TICKS;
    const dv = e.shiftKey ? KEY_VALUE_COARSE : KEY_VALUE;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': nudge(-dt, 0); break;
      case 'ArrowRight': nudge(dt, 0); break;
      case 'ArrowUp': nudge(0, dv); break;
      case 'ArrowDown': nudge(0, -dv); break;
      case 'Delete':
      case 'Backspace':
        if (selected) write(removeCcPoint(points, selected.tick));
        break;
      case 'Home':
        if (points[0]) setSelectedTick(points[0].tick);
        break;
      case 'End':
        if (points.length) setSelectedTick(points[points.length - 1].tick);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const next = selected ? points.find((p) => p.tick > selected.tick) ?? null : null;
  const ramp = () => {
    if (!selected || !next) return;
    write(replaceCcSpan(points, selected.tick, next.tick, rampPoints(selected.tick, selected.value, next.tick, next.value)));
  };

  const selectId = `cc-lane-controller-${part.id}`;
  const where = (tick: number): string => {
    const step = tick / TICKS_PER_STEP;
    const b = barAt(meterMap, Math.max(0, step), pickupSteps);
    return b.bar < 0 ? 'the pickup' : `bar ${b.bar + 1}, step ${Math.round((step - b.start) * 100) / 100 + 1}`;
  };
  const pointText = selected ? `${selected.value} at ${where(selected.tick)}` : 'No change selected';
  const recCount = [...recorded.values()].reduce((n, p) => n + p.length, 0);

  return (
    <div className="shrink-0 border-t border-white/8 bg-black/30" data-cc-lane>
      <div className="h-6.5 flex items-center gap-1.5 px-1.5 border-b border-white/5">
        <span className={FIELD_LEGEND}>CC</span>
        <div className={FIELD}>
          <label htmlFor={selectId} className={FIELD_LEGEND}>Controller</label>
          <select
            id={selectId}
            name={selectId}
            value={controller}
            onChange={(e) => setController(Number(e.target.value))}
            className={FIELD_SELECT}
          >
            {CC_LANE_CONTROLLERS.map((cc) => (
              <option key={cc} value={cc}>{ccLabel(cc)}</option>
            ))}
          </select>
        </div>
        <span className={FIELD_VALUE} title="The selected change">
          {selected ? `${selected.value}` : '—'}
        </span>
        <StripKey
          mini
          on={draw}
          aria-pressed={draw}
          onClick={() => setDraw(!draw)}
          icon={<PenLine className={MINI_GLYPH} />}
          legend="Draw"
          description="Drag across the strip to draw the curve: a change every 64th where the value moves. A swell inside a held note is drawn this way."
        />
        <StripKey
          mini
          onClick={ramp}
          disabled={!selected || !next}
          icon={<TrendingUp className={MINI_GLYPH} />}
          legend="Ramp"
          description={selected && next ? 'Write a straight ramp from the selected change to the next one' : 'Select a change with one after it to ramp between them'}
        />
        <StripKey
          mini
          rec={rec}
          aria-pressed={rec}
          onClick={() => setRec(!rec)}
          icon={<Circle className={MINI_GLYPH} />}
          legend="Rec"
          description="Record a hardware controller while the roll plays: its changes are written into this part at the playhead, and the pass lands when PLAY stops"
        />
        {rec && (
          <span className={FIELD_VALUE} role="status">
            {isPlaying ? `Recording · ${recCount}` : 'Press PLAY to record'}
          </span>
        )}
        <span className="flex-1" />
        <StripKey
          mini
          iconOnly
          onClick={() => {
            write([]);
            setSelectedTick(null);
          }}
          disabled={stored.length === 0}
          icon={<Eraser className={MINI_GLYPH} />}
          legend="Clear controller"
          description={`Remove every ${ccLabel(controller)} change from ${part.name}; its other controllers stay`}
          className={MINI_ICON_KEY}
        />
      </div>

      <div
        ref={surfaceRef}
        role="slider"
        tabIndex={0}
        aria-label={`${ccLabel(controller)} for ${part.name}, ${points.length} change${points.length === 1 ? '' : 's'}`}
        aria-valuemin={0}
        aria-valuemax={127}
        aria-valuenow={selected?.value ?? info?.initial ?? 0}
        aria-valuetext={pointText}
        aria-describedby="cc-lane-help"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={`relative outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-accent))] ${draw ? 'cursor-cell' : 'cursor-crosshair'}`}
        style={{ width, height }}
      >
        <svg width={width} height={height} className="absolute inset-0 pointer-events-none" shapeRendering="geometricPrecision">
          {/* Where the channel starts, and the middle of the range. */}
          <line
            x1={0}
            x2={width}
            y1={ccValueToY(info?.initial ?? 0, height)}
            y2={ccValueToY(info?.initial ?? 0, height)}
            stroke="rgb(255 255 255 / 0.18)"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
          <line x1={0} x2={width} y1={ccValueToY(64, height)} y2={ccValueToY(64, height)} stroke="rgb(255 255 255 / 0.06)" strokeWidth={1} />
          <path d={d} fill="none" stroke="rgb(var(--et-accent))" strokeWidth={1.5} />
          {points.length <= 400 &&
            points.map((p) => (
              <circle
                key={p.tick}
                cx={(p.tick / TICKS_PER_STEP) * stepPx}
                cy={ccValueToY(p.value, height)}
                r={p.tick === selectedTick ? CC_POINT_R + 1.5 : CC_POINT_R}
                fill={p.tick === selectedTick ? 'rgb(var(--et-accent))' : 'rgb(10 8 15)'}
                stroke="rgb(var(--et-accent))"
                strokeWidth={1.5}
              />
            ))}
        </svg>
      </div>
      <p id="cc-lane-help" className="sr-only">
        Click to add a change, drag to move it, Alt-click to remove it. With Draw on, drag to draw the curve. The arrow
        keys move the selected change, Shift for a coarser step, Delete removes it. Home and End select the first and
        last change.
      </p>
    </div>
  );
};

/**
 * CC: opens the CC lane under the grid. It latches like BEND, and counts the
 * controller changes the part being edited carries, so a part with a drawn
 * swell or a file's pedal says so with the lane closed.
 */
export const PianoRollCcKey: React.FC<{ on: boolean; onChange: (on: boolean) => void }> = ({ on, onChange }) => {
  const count = usePianoRollStore((s) => activeTrackOf(s).controls?.length ?? 0);
  return (
    <StripKey
      on={on}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      legend="CC"
      icon={<SlidersHorizontal className={STRIP_GLYPH} />}
      description={
        count > 0
          ? `Controller lane under the grid: modulation, volume, pan, expression, pedal, brightness and reverb send. This part carries ${count} change${count === 1 ? '' : 's'}.`
          : 'Controller lane under the grid: draw modulation, volume, pan, expression, pedal, brightness or reverb send for this part'
      }
    />
  );
};
