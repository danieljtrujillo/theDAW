/**
 * The TEMPO lane: the strip under the piano roll where the roll's tempo map is
 * drawn and edited, and the row of controls that goes with it.
 *
 * The roll's document holds a tempo map (lib/rollTempo): the starting tempo at
 * beat 0 (the header's BPM), then tempo changes, ramps and fermatas. The
 * scheduler, every bounce and the MIDI file all play it, and notes stay on
 * their bar lines whatever it does: a ritardando is written as tempo, not as
 * notes moved late.
 *
 * The strip shares the grid's x scale, so a tempo change sits over the bar
 * line it changes at, and scrolls with the grid inside the same scroll box.
 * Its y scale is tempo, spanning the map's own range (lib/tempoLane).
 *
 * Editing:
 *   - a click on empty strip adds a point there of the MODE the key shows:
 *     STEP holds its tempo until the next point, RAMP slides to the next
 *     point's tempo (a ritardando or accelerando), HOLD adds a fermata
 *   - a drag moves a point: the beat snaps to the grid and the tempo to a
 *     whole BPM, and Alt takes both free. The starting tempo stays at beat 0.
 *   - a click on a point selects it; the row then edits it: its BPM, and
 *     STEP/RAMP for a tempo point; how many beats it holds and how much longer
 *     each lasts for a fermata
 *   - Delete, Backspace or an Alt-click removes the selected point; the
 *     arrows move it, Shift for a coarse step; CLEAR removes every point but
 *     the starting tempo
 *   - MODULATE (MetricModulation.tsx) puts a metric modulation on a bar line:
 *     "dotted quarter = quarter" and the tempo it gives from the one in force
 * Every edit is a document edit: undo takes it back.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';
import { beginRollGesture, endRollGesture, usePianoRollStore, type TempoEventKind } from '../../state/pianoRollStore';
import { barAt } from '../../lib/meterMap';
import { PPQ } from '../../lib/noteClock';
import { tickBeat } from '../../lib/rollTempo';
import {
  DEFAULT_FERMATA,
  FERMATA_BAND,
  TEMPO_LANE_HEIGHT,
  TEMPO_MODE_LABEL,
  TEMPO_MODE_TITLE,
  TEMPO_POINT_R,
  beatToX,
  fermataAt,
  fermataMarks,
  nextTempoMode,
  snapTempo,
  snapTempoBeat,
  tempoLaneRange,
  tempoPath,
  tempoPointAt,
  tempoText,
  tempoToY,
  yToTempo,
  type TempoLaneMode,
  type TempoRange,
} from '../../lib/tempoLane';
import { FERMATA_STRETCH_MAX, FERMATA_STRETCH_MIN, TEMPO_BPM_MAX, TEMPO_BPM_MIN, getTempoAtBeat, type TempoEvent } from '../../lib/tempoMap';
import { FIELD, FIELD_LEGEND, FIELD_VALUE, MINI_GLYPH, MINI_ICON_KEY, StripKey } from './midiDockKit';
import { MetricModulationKey } from './MetricModulation';

/** Steps a key press moves a point by, and the coarse step under Shift. */
const KEY_STEP = 1;
const KEY_STEP_COARSE = 4;
/** BPM a key press moves a point by, and the coarse step under Shift. */
const KEY_BPM = 1;
const KEY_BPM_COARSE = 10;

/** The selected point: its beat and which kind it is. */
interface Picked {
  beat: number;
  kind: TempoEventKind;
}

const kindOf = (e: TempoEvent): TempoEventKind => (e.fermata ? 'fermata' : 'tempo');

/** The beat a point moved to `beat` lands on in the store: the start stays at 0, any other tempo point is at least a tick in. */
const landedBeat = (p: Picked, beat: number): number =>
  p.kind === 'tempo' ? (p.beat === 0 ? 0 : Math.max(tickBeat(1 / PPQ), tickBeat(beat))) : tickBeat(beat);

/** A fermata's words: "holds 1 beat x2". */
export const fermataReading = (f: NonNullable<TempoEvent['fermata']>): string =>
  `holds ${tempoText(f.beats)} beat${f.beats === 1 ? '' : 's'} x${tempoText(f.stretch)}`;

interface TempoLaneProps {
  /** Grid px per step, shared with the roll so a point sits over its bar line. */
  stepPx: number;
  totalSteps: number;
  /** Steps a point snaps to (1 = a 16th). */
  quantum?: number;
}

export const TempoLane: React.FC<TempoLaneProps> = ({ stepPx, totalSteps, quantum = 1 }) => {
  const tempoMap = usePianoRollStore((s) => s.tempoMap);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const addTempoEvent = usePianoRollStore((s) => s.addTempoEvent);
  const moveTempoEvent = usePianoRollStore((s) => s.moveTempoEvent);
  const removeTempoEvent = usePianoRollStore((s) => s.removeTempoEvent);
  const setTempoMap = usePianoRollStore((s) => s.setTempoMap);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The point being dragged, where it is now, and the range the drag started
  // with: the range holds still under the pointer until the drag ends.
  const dragRef = useRef<{ picked: Picked; range: TempoRange } | null>(null);
  const [dragRange, setDragRange] = useState<TempoRange | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [mode, setMode] = useState<TempoLaneMode>('step');

  const selected = picked ? tempoMap.find((e) => e.beat === picked.beat && kindOf(e) === picked.kind) ?? null : null;
  // A point removed under the selection (an undo, CLEAR) drops it.
  useEffect(() => {
    if (picked && !selected) setPicked(null);
  }, [picked, selected]);
  // The lane closed under a drag: the drag's undo step ends with it, so the
  // next edit anywhere in the roll is a step of its own.
  useEffect(
    () => () => {
      if (dragRef.current) endRollGesture();
    },
    [],
  );

  const width = Math.max(1, totalSteps * stepPx);
  const height = TEMPO_LANE_HEIGHT;
  const range = useMemo(() => dragRange ?? tempoLaneRange(tempoMap), [dragRange, tempoMap]);
  const d = useMemo(() => tempoPath(tempoMap, { stepPx, totalSteps, height, range }), [tempoMap, stepPx, totalSteps, height, range]);
  const marks = useMemo(() => fermataMarks(tempoMap, stepPx), [tempoMap, stepPx]);
  const tempi = tempoMap.filter((e) => !e.fermata);
  const changes = tempoMap.length - 1;

  const localPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const r = surfaceRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localPoint(e);
    const hit = fermataAt(tempoMap, x, y, stepPx) ?? tempoPointAt(tempoMap, x, y, { stepPx, height, range });
    if (hit && e.altKey) {
      removeTempoEvent(hit.beat, kindOf(hit));
      setPicked(null);
      e.preventDefault();
      return;
    }
    // Placing a point and dragging it is one undo step, however long the drag pauses.
    beginRollGesture();
    let target: Picked;
    if (hit) target = { beat: hit.beat, kind: kindOf(hit) };
    else {
      const beat = snapTempoBeat(x, stepPx, totalSteps, quantum, e.altKey);
      if (mode === 'fermata') {
        addTempoEvent({ beat, bpm: getTempoAtBeat(tempoMap, beat), fermata: { ...DEFAULT_FERMATA } });
        target = { beat, kind: 'fermata' };
      } else {
        addTempoEvent({ beat, bpm: snapTempo(yToTempo(y, range, height), e.altKey), curve: mode });
        target = { beat, kind: 'tempo' };
      }
    }
    setPicked(target);
    dragRef.current = { picked: target, range };
    setDragRange(range);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = localPoint(e);
    const beat = snapTempoBeat(x, stepPx, totalSteps, quantum, e.altKey);
    const start = drag.picked.kind === 'tempo' && drag.picked.beat === 0;
    const patch: Partial<TempoEvent> = drag.picked.kind === 'fermata'
      ? { beat }
      : { beat, bpm: snapTempo(yToTempo(y, drag.range, height), e.altKey) };
    moveTempoEvent(drag.picked.beat, drag.picked.kind, patch);
    // Where the point landed, so the next move finds it: the store keeps the
    // start at 0 and every other tempo point at least a tick after it.
    const landed = landedBeat(drag.picked, beat);
    const now = usePianoRollStore.getState().tempoMap.find((ev) => kindOf(ev) === drag.picked.kind && ev.beat === landed);
    const next = { beat: now ? now.beat : drag.picked.beat, kind: drag.picked.kind };
    dragRef.current = { ...drag, picked: next };
    setPicked(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragRange(null);
    endRollGesture();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const nudge = useCallback(
    (dStep: number, dBpm: number) => {
      if (!selected || !picked) return;
      const beat = Math.max(0, Math.min(totalSteps / 4, selected.beat + dStep / 4));
      moveTempoEvent(selected.beat, picked.kind, picked.kind === 'fermata' ? { beat } : { beat, bpm: snapTempo(selected.bpm + dBpm, true) });
      setPicked({ beat: landedBeat(picked, beat), kind: picked.kind });
    },
    [moveTempoEvent, picked, selected, totalSteps],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    const bpm = e.shiftKey ? KEY_BPM_COARSE : KEY_BPM;
    const ordered = [...tempoMap];
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': nudge(-step, 0); break;
      case 'ArrowRight': nudge(step, 0); break;
      case 'ArrowUp': nudge(0, bpm); break;
      case 'ArrowDown': nudge(0, -bpm); break;
      case 'Delete':
      case 'Backspace':
        if (selected && picked) removeTempoEvent(selected.beat, picked.kind);
        break;
      case 'Home':
        if (ordered[0]) setPicked({ beat: ordered[0].beat, kind: kindOf(ordered[0]) });
        break;
      case 'End': {
        const last = ordered[ordered.length - 1];
        if (last) setPicked({ beat: last.beat, kind: kindOf(last) });
        break;
      }
      default:
        handled = false;
    }
    // The roll and the window share these keys; a handled one stops here.
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const barOf = (beat: number): string => {
    const bar = barAt(meterMap, beat * 4, pickupSteps).bar;
    return bar < 0 ? 'the pickup' : `bar ${bar + 1}`;
  };

  const bpmId = 'tempo-lane-bpm';
  const holdId = 'tempo-lane-hold';
  const stretchId = 'tempo-lane-stretch';
  const isStart = picked?.kind === 'tempo' && selected?.beat === 0;
  // The strip is a slider over the selected point: its tempo (a fermata's is
  // the written tempo in force where it holds, before the hold slows it), or
  // the starting tempo with none picked.
  const pointBpm = selected ? (selected.fermata ? getTempoAtBeat(tempi, selected.beat) : selected.bpm) : tempi[0]?.bpm ?? 120;
  const pointText = selected
    ? selected.fermata
      ? `Fermata at ${barOf(selected.beat)}, ${fermataReading(selected.fermata)}, at ${tempoText(pointBpm)} BPM`
      : `${tempoText(pointBpm)} BPM, ${isStart ? 'the start' : selected.curve === 'linear' ? 'a ramp' : 'a step'} at ${barOf(selected.beat)}`
    : `No point selected; the tempo starts at ${tempoText(pointBpm)} BPM`;

  return (
    <div className="shrink-0 border-t border-white/8 bg-black/30" data-tempo-lane>
      <div className="h-6.5 flex items-center gap-1.5 px-1.5 border-b border-white/5">
        <span className={FIELD_LEGEND}>Tempo</span>

        <StripKey
          mini
          onClick={() => setMode(nextTempoMode(mode))}
          legend={TEMPO_MODE_LABEL[mode]}
          aria-label={`What a click adds: ${TEMPO_MODE_LABEL[mode]}`}
          description={TEMPO_MODE_TITLE[mode]}
        />

        {selected && picked?.kind === 'tempo' && (
          <>
            <div className={FIELD}>
              <label htmlFor={bpmId} className={FIELD_LEGEND}>BPM</label>
              <input
                key={`${selected.beat}:${selected.bpm}`}
                id={bpmId}
                name={bpmId}
                type="number"
                min={TEMPO_BPM_MIN}
                max={TEMPO_BPM_MAX}
                step="any"
                defaultValue={tempoText(selected.bpm)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                onBlur={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  if (Number.isFinite(v) && v > 0) moveTempoEvent(selected.beat, 'tempo', { bpm: snapTempo(v, true) });
                  else e.target.value = tempoText(selected.bpm);
                }}
                title={isStart ? 'The starting tempo, the same as the header\'s BPM' : 'This point\'s tempo'}
                className="w-13 h-5 bg-transparent border-none outline-none text-[12px] font-bold et-ink tabular-nums"
              />
            </div>
            <StripKey
              mini
              on={selected.curve === 'linear'}
              aria-pressed={selected.curve === 'linear'}
              onClick={() => moveTempoEvent(selected.beat, 'tempo', { curve: selected.curve === 'linear' ? 'step' : 'linear' })}
              legend="Ramp"
              aria-label="Ramp from this point to the next"
              description={selected.curve === 'linear'
                ? 'Ramps to the next point\'s tempo. Press to hold this tempo until the next point instead.'
                : 'Holds this tempo until the next point. Press to ramp to the next point\'s tempo.'}
            />
          </>
        )}

        {selected?.fermata && picked?.kind === 'fermata' && (
          <>
            <div className={FIELD}>
              <label htmlFor={holdId} className={FIELD_LEGEND}>Hold</label>
              <input
                key={`h${selected.beat}:${selected.fermata.beats}`}
                id={holdId}
                name={holdId}
                type="number"
                min={0.25}
                step={0.25}
                defaultValue={tempoText(selected.fermata.beats)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                onBlur={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  if (Number.isFinite(v) && v > 0) moveTempoEvent(selected.beat, 'fermata', { fermata: { beats: v, stretch: selected.fermata?.stretch ?? 2 } });
                  else e.target.value = tempoText(selected.fermata?.beats ?? 1);
                }}
                title="How many quarter-note beats the fermata holds"
                className="w-10 h-5 bg-transparent border-none outline-none text-[12px] font-bold et-ink tabular-nums"
              />
              <span className={FIELD_VALUE}>beats</span>
            </div>
            <div className={FIELD}>
              <label htmlFor={stretchId} className={FIELD_LEGEND}>Times</label>
              <input
                key={`s${selected.beat}:${selected.fermata.stretch}`}
                id={stretchId}
                name={stretchId}
                type="number"
                min={FERMATA_STRETCH_MIN}
                max={FERMATA_STRETCH_MAX}
                step={0.25}
                defaultValue={tempoText(selected.fermata.stretch)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                onBlur={(e) => {
                  const v = Number.parseFloat(e.target.value);
                  if (Number.isFinite(v) && v > 0) moveTempoEvent(selected.beat, 'fermata', { fermata: { beats: selected.fermata?.beats ?? 1, stretch: v } });
                  else e.target.value = tempoText(selected.fermata?.stretch ?? 2);
                }}
                title="How many times longer each held beat lasts"
                className="w-10 h-5 bg-transparent border-none outline-none text-[12px] font-bold et-ink tabular-nums"
              />
            </div>
          </>
        )}

        <span className={FIELD_VALUE} title="The selected point">
          {selected
            ? selected.fermata
              ? `Fermata at ${barOf(selected.beat)}, ${fermataReading(selected.fermata)}`
              : `${isStart ? 'Start' : selected.curve === 'linear' ? 'Ramp' : 'Step'} at ${barOf(selected.beat)}`
            : changes > 0
              ? `${changes} point${changes === 1 ? '' : 's'} after the start`
              : 'One tempo'}
        </span>

        <span className="flex-1" />

        <MetricModulationKey idBase="tempo-lane-mod" mini />
        <StripKey
          mini
          iconOnly
          onClick={() => { if (selected && picked) removeTempoEvent(selected.beat, picked.kind); }}
          disabled={!selected || isStart}
          icon={<span className="text-[12px] font-bold leading-none">×</span>}
          legend="Remove point"
          description={isStart ? 'The starting tempo stays; the header\'s BPM changes it' : 'Remove the selected point'}
          className={MINI_ICON_KEY}
        />
        <StripKey
          mini
          iconOnly
          onClick={() => { setTempoMap(tempi.filter((e) => e.beat === 0)); setPicked(null); }}
          disabled={changes === 0}
          icon={<Eraser className={MINI_GLYPH} />}
          legend="Clear tempo"
          description="Remove every tempo change, ramp and fermata; the starting tempo stays"
          className={MINI_ICON_KEY}
        />
      </div>

      {/* The strip: a slider whose value is the selected point's tempo. The arrow
          keys move that point (up and down its tempo, left and right its beat),
          and a screen reader announces its tempo and bar as it moves. */}
      <div
        ref={surfaceRef}
        role="slider"
        tabIndex={0}
        aria-label={`Tempo map, ${tempi.length} tempo point${tempi.length === 1 ? '' : 's'} and ${marks.length} fermata${marks.length === 1 ? '' : 's'}, starting at ${tempoText(tempi[0]?.bpm ?? 120)} BPM`}
        aria-valuemin={TEMPO_BPM_MIN}
        aria-valuemax={TEMPO_BPM_MAX}
        aria-valuenow={Math.round(pointBpm * 100) / 100}
        aria-valuetext={pointText}
        aria-describedby="tempo-lane-help"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className="relative cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-accent))]"
        style={{ width, height }}
      >
        <svg width={width} height={height} className="absolute inset-0 pointer-events-none" shapeRendering="geometricPrecision">
          {/* The fermata band, and each hold's span under its mark. */}
          <line x1={0} x2={width} y1={FERMATA_BAND} y2={FERMATA_BAND} stroke="rgb(255 255 255 / 0.07)" strokeWidth={1} />
          {marks.map((m) => {
            const on = picked?.kind === 'fermata' && selected?.beat === m.event.beat;
            return (
              <g key={`f${m.event.beat}`}>
                <rect x={m.x} y={FERMATA_BAND} width={Math.max(1, m.endX - m.x)} height={height - FERMATA_BAND} fill="rgb(var(--et-accent) / 0.1)" />
                {/* The fermata sign: an arc over a dot. */}
                <path
                  d={`M ${m.x - 7} ${FERMATA_BAND - 5} A 7 7 0 0 1 ${m.x + 7} ${FERMATA_BAND - 5}`}
                  fill="none"
                  stroke="rgb(var(--et-accent))"
                  strokeWidth={on ? 2.5 : 1.5}
                />
                <circle cx={m.x} cy={FERMATA_BAND - 6} r={on ? 2.5 : 2} fill="rgb(var(--et-accent))" />
              </g>
            );
          })}
          <path d={d} fill="none" stroke="rgb(var(--et-accent))" strokeWidth={1.5} />
          {tempi.map((e) => {
            const on = picked?.kind === 'tempo' && selected?.beat === e.beat;
            const cx = beatToX(e.beat, stepPx);
            const cy = tempoToY(e.bpm, range, height);
            return (
              <g key={`t${e.beat}`}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={on ? TEMPO_POINT_R + 1.5 : TEMPO_POINT_R}
                  fill={on ? 'rgb(var(--et-accent))' : 'rgb(10 8 15)'}
                  stroke="rgb(var(--et-accent))"
                  strokeWidth={1.5}
                />
                <text
                  x={cx + 7}
                  y={cy > height - 16 ? cy - 7 : cy + 16}
                  fill="rgb(var(--et-ink))"
                  fontSize={12}
                  fontWeight={700}
                  className="font-sans"
                >
                  {tempoText(e.bpm)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p id="tempo-lane-help" className="sr-only">
        Click to add a point of the kind the mode key shows: a step, a ramp or a fermata. Drag a point to move it,
        Alt-click to remove it, Alt while dragging places it off the grid. The arrow keys move the selected point,
        Shift for a coarser step, Delete removes it. Home and End select the first and last point.
      </p>
    </div>
  );
};
