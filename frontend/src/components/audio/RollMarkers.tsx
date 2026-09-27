/**
 * The piano roll's named markers: the MARKER ROW under the ruler and the MARKS
 * jump list in the keyboard column's corner (lib/rollMarkers holds the model).
 *
 * The row draws each marker as a flag at its step, labelled with its name: a
 * movement solid in the accent, a section tinted. A flag is a button:
 *   - click (or Enter) jumps: the playhead moves to it and the grid scrolls it in
 *   - double-click (or F2) renames it in place
 *   - a drag moves it to the nearest bar line (Shift: the nearest step), one
 *     undo step per drag
 *   - the arrow keys move it a bar (Shift: a step), Delete removes it
 * A double-click on the row's empty ground adds a section at the bar line
 * before the pointer. The flag whose span holds the playhead reads bolder.
 *
 * The jump list lists every marker in order with its bar, a name field and a
 * kind picker, adds a section or a movement at the playhead's bar, and steps to
 * the previous or next marker. Every change is a roll document edit, so undo
 * covers it.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { beginRollGesture, endRollGesture, usePianoRollStore } from '../../state/pianoRollStore';
import { barAt, barLines, type MeterSegment } from '../../lib/meterMap';
import {
  MARKER_NAME_MAX,
  markerAround,
  markerBarLabel,
  markerSpoken,
  markerStep,
  type RollMarker,
  type RollMarkerKind,
} from '../../lib/rollMarkers';
import { DockFlyout, FLYOUT_CARD, FLYOUT_LEGEND, MINI_ICON_KEY, StripKey, keyTone } from './midiDockKit';

/** The marker row's height, under the ruler. */
export const MARKER_ROW_HEIGHT = 20;
/** A pointer that travels less than this is a click on a flag, not a drag. */
const FLAG_DRAG_MIN_PX = 3;
/** The narrowest a flag gets when the next one is close: its edge and a letter. */
const FLAG_MIN_PX = 14;
/** A flag's label stops this far before the next flag. */
const FLAG_GAP_PX = 2;

const kindWord = (k: RollMarkerKind): string => (k === 'movement' ? 'Movement' : 'Section');

/** The id of the marker whose span holds `step`: the last one at or before it. */
export const currentMarkerId = (markers: readonly RollMarker[], step: number): string | null => {
  let hit: string | null = null;
  for (const m of markers) {
    if (markerStep(m) <= step + 1e-9) hit = m.id;
    else break;
  }
  return hit;
};

/** The bar line nearest `step` (the roll's bar lines, 0 included). */
const nearestBarLine = (lines: readonly number[], step: number): number => {
  let best = lines[0] ?? 0;
  for (const l of lines) if (Math.abs(l - step) < Math.abs(best - step)) best = l;
  return best;
};

/** The step a keyboard move lands on: a bar line before or after `step`, or one step with `fine`. */
const keyMoveStep = (lines: readonly number[], step: number, dir: -1 | 1, fine: boolean, totalSteps: number): number => {
  if (fine) return Math.max(0, Math.min(Math.max(0, totalSteps - 1), Math.round(step) + dir));
  if (dir > 0) return lines.find((l) => l > step + 1e-9) ?? step;
  let prev = step;
  for (const l of lines) if (l < step - 1e-9) prev = l;
  return prev;
};

/** The bar line a new marker takes: the start of the bar under `step`. */
export const markerBarStart = (meterMap: readonly MeterSegment[], step: number, pickupSteps: number): number =>
  barAt(meterMap, Math.max(0, step), pickupSteps).start;

interface MarkerRowProps {
  /** The row's sticky top: the ruler's height. */
  top: number;
  stepPx: number;
  totalSteps: number;
  meterMap: MeterSegment[];
  pickupSteps: number;
  /** Move the playhead to `step` and scroll it into view. */
  onJump: (step: number) => void;
}

/** The marker row under the ruler. See the module comment. */
export function RollMarkerRow({ top, stepPx, totalSteps, meterMap, pickupSteps, onJump }: MarkerRowProps) {
  const markers = usePianoRollStore((s) => s.markers);
  const current = usePianoRollStore((s) => currentMarkerId(s.markers, s.currentStep));
  const [renaming, setRenaming] = useState<string | null>(null);
  const helpId = useId();
  const lines = useMemo(() => barLines(meterMap, totalSteps, pickupSteps), [meterMap, totalSteps, pickupSteps]);
  const pressRef = useRef<{ id: string; startX: number; startStep: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const width = totalSteps * stepPx;
  const shown = markers.filter((m) => markerStep(m) < totalSteps);

  // After the write re-renders the row, focus goes back to the flag (a rename, a move) or its neighbour (a removal).
  const focusFlag = (id: string) =>
    window.requestAnimationFrame(() => {
      const flags = [...document.querySelectorAll<HTMLElement>('[data-roll-marker]')];
      flags.find((el) => el.getAttribute('data-roll-marker') === id)?.focus();
    });

  const onRowDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('[data-roll-marker], input')) return;
    const step = (e.clientX - e.currentTarget.getBoundingClientRect().left) / stepPx;
    const at = markerBarStart(meterMap, Math.min(step, Math.max(0, totalSteps - 1)), pickupSteps);
    const id = usePianoRollStore.getState().addMarker({ step: at, kind: 'section' });
    setRenaming(id);
  };

  const onFlagPointerDown = (e: React.PointerEvent<HTMLButtonElement>, m: RollMarker) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    pressRef.current = { id: m.id, startX: e.clientX, startStep: markerStep(m), dragging: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onFlagPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press) return;
    e.stopPropagation();
    const dx = e.clientX - press.startX;
    if (!press.dragging) {
      if (Math.abs(dx) < FLAG_DRAG_MIN_PX) return;
      press.dragging = true;
      // One undo step for the whole drag, however slow.
      beginRollGesture();
    }
    const raw = Math.max(0, Math.min(Math.max(0, totalSteps - 1), press.startStep + dx / stepPx));
    const step = e.shiftKey ? Math.round(raw) : nearestBarLine(lines, raw);
    usePianoRollStore.getState().updateMarker(press.id, { step });
  };
  const endPress = (e: React.PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    e.stopPropagation();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (press.dragging) {
      endRollGesture();
      // The click that follows a drag is not a jump.
      suppressClickRef.current = true;
    }
  };

  const onFlagKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, m: RollMarker) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const roll = usePianoRollStore.getState();
    if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      setRenaming(m.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      const i = shown.findIndex((x) => x.id === m.id);
      roll.removeMarker(m.id);
      const next = shown[i + 1] ?? shown[i - 1];
      if (next) focusFlag(next.id);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const to = keyMoveStep(lines, markerStep(m), e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey, totalSteps);
      roll.updateMarker(m.id, { step: to });
      focusFlag(m.id);
    }
  };

  return (
    <div
      data-roll-markers=""
      role="group"
      aria-label="Markers: sections and movements. Double-click the row to add a section at a bar line."
      className="sticky z-20 bg-[#07050a] border-b border-white/5 select-none"
      style={{ top, height: MARKER_ROW_HEIGHT, width, minWidth: '100%' }}
      onDoubleClick={onRowDoubleClick}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span id={helpId} className="sr-only">
        Enter jumps to the marker. F2 renames it. The arrow keys move it a bar, with Shift a step. Delete removes it.
      </span>
      {shown.length === 0 && (
        <span aria-hidden="true" className="absolute left-1 top-0 bottom-0 flex items-center text-[12px] font-bold et-ink-3 whitespace-nowrap pointer-events-none">
          Double-click to add a section marker
        </span>
      )}
      {shown.map((m, i) => {
        const step = markerStep(m);
        const nextStep = shown[i + 1] ? markerStep(shown[i + 1]) : totalSteps;
        const room = Math.max(FLAG_MIN_PX, (nextStep - step) * stepPx - FLAG_GAP_PX);
        const bar = markerBarLabel(m, meterMap, pickupSteps);
        const isCurrent = current === m.id;
        if (renaming === m.id) {
          return (
            <MarkerRename
              key={m.id}
              marker={m}
              left={step * stepPx}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null) usePianoRollStore.getState().updateMarker(m.id, { name });
                focusFlag(m.id);
              }}
            />
          );
        }
        return (
          <button
            key={m.id}
            type="button"
            data-roll-marker={m.id}
            data-marker-kind={m.kind}
            aria-label={markerSpoken(m, meterMap, pickupSteps)}
            aria-describedby={helpId}
            aria-current={isCurrent ? 'true' : undefined}
            title={`${kindWord(m.kind)} ${m.name} · ${bar}. Click to jump, double-click to rename, drag to move (Shift: by step).`}
            className={`absolute top-0 bottom-0 flex items-center pl-1 pr-1.5 border-l-2 text-[12px] leading-none whitespace-nowrap overflow-hidden cursor-grab outline-none focus-visible:shadow-[inset_0_0_0_1px_rgb(var(--et-ink))] ${
              m.kind === 'movement'
                ? 'bg-[rgb(var(--et-accent))] text-[#07050a] border-[rgb(var(--et-ink))]'
                : 'bg-[rgb(var(--et-accent)/0.16)] et-ink border-[rgb(var(--et-accent))]'
            } ${isCurrent ? 'font-extrabold' : 'font-bold'}`}
            style={{ left: step * stepPx, maxWidth: room }}
            onPointerDown={(e) => onFlagPointerDown(e, m)}
            onPointerMove={onFlagPointerMove}
            onPointerUp={endPress}
            onPointerCancel={endPress}
            onLostPointerCapture={endPress}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onJump(step);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(m.id);
            }}
            onKeyDown={(e) => onFlagKeyDown(e, m)}
          >
            <span className="truncate">{m.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The in-place name field a double-click or F2 opens on a flag. Enter or leaving it keeps the name; Escape keeps the old one. */
function MarkerRename({ marker, left, onDone }: { marker: RollMarker; left: number; onDone: (name: string | null) => void }) {
  const [draft, setDraft] = useState(marker.name);
  const doneRef = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const inputId = `roll-marker-rename-${marker.id}`;
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(name);
  };
  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        Rename {kindWord(marker.kind).toLowerCase()} {marker.name}
      </label>
      <input
        ref={ref}
        id={inputId}
        name="roll-marker-rename"
        type="text"
        maxLength={MARKER_NAME_MAX}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(draft);
          else if (e.key === 'Escape') finish(null);
        }}
        onBlur={() => finish(draft)}
        className="absolute top-0 bottom-0 z-10 w-40 px-1 text-[12px] font-bold et-ink bg-[#0a080f] border border-[rgb(var(--et-accent))] outline-none"
        style={{ left }}
      />
    </>
  );
}

interface MarkerJumpProps {
  /** Move the playhead to `step` and scroll it into view. */
  onJump: (step: number) => void;
}

/** The MARKS key in the keyboard column's corner and its jump list. See the module comment. */
export function RollMarkerJump({ onJump }: MarkerJumpProps) {
  const markers = usePianoRollStore((s) => s.markers);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const currentStep = usePianoRollStore((s) => s.currentStep);
  const [open, setOpen] = useState(false);
  const keyRef = useRef<HTMLButtonElement>(null);
  const count = markers.length;
  const around = markerAround(markers, currentStep);

  const add = (kind: RollMarkerKind) => {
    const s = usePianoRollStore.getState();
    s.addMarker({ step: markerBarStart(s.meterMap, s.currentStep, s.pickupSteps), kind });
  };

  return (
    <>
      <button
        ref={keyRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="roll-marker-list"
        aria-label={`Markers: ${count === 0 ? 'none yet' : `${count} marker${count === 1 ? '' : 's'}`}. Open the jump list`}
        title="Markers: jump to a section or movement, add, rename or remove one"
        onClick={() => setOpen((v) => !v)}
        className={`w-full h-full flex items-center justify-center text-[12px] leading-none font-display font-bold uppercase outline-none focus-visible:shadow-[inset_0_0_0_1px_rgb(var(--et-accent))] ${
          open ? 'et-accent-legend' : 'et-ink-2 hover:et-ink'
        }`}
      >
        Marks
      </button>
      <DockFlyout
        open={open}
        anchorRef={keyRef}
        onClose={() => setOpen(false)}
        placement="right"
        id="roll-marker-list"
        role="dialog"
        aria-label="Markers"
        className={`w-96 p-2 flex flex-col gap-1.5 ${FLYOUT_CARD}`}
      >
        <div className="flex items-center gap-1">
          <span className={`${FLYOUT_LEGEND} mr-auto`}>Markers</span>
          <StripKey
            flyout
            onClick={() => add('section')}
            aria-label="Add a section marker at the playhead's bar"
            icon={<Plus className="w-3 h-3" />}
            legend="Section"
          />
          <StripKey
            flyout
            onClick={() => add('movement')}
            aria-label="Add a movement marker at the playhead's bar"
            icon={<Plus className="w-3 h-3" />}
            legend="Movement"
          />
        </div>
        <div className="flex items-center gap-1">
          <StripKey
            flyout
            disabled={!around.prev}
            onClick={() => around.prev && onJump(markerStep(around.prev))}
            aria-label={around.prev ? `Previous marker: ${markerSpoken(around.prev, meterMap, pickupSteps)}` : 'No marker before the playhead'}
            icon={<ChevronLeft className="w-3 h-3" />}
            legend="Prev"
          />
          <StripKey
            flyout
            disabled={!around.next}
            onClick={() => around.next && onJump(markerStep(around.next))}
            aria-label={around.next ? `Next marker: ${markerSpoken(around.next, meterMap, pickupSteps)}` : 'No marker after the playhead'}
            icon={<ChevronRight className="w-3 h-3" />}
            legend="Next"
          />
        </div>
        {count === 0 ? (
          <p className="text-[12px] font-semibold et-ink-3 leading-snug">
            No markers yet. Add one at the playhead's bar, or double-click the marker row under the ruler. SONG writes a marker for each FORM section.
          </p>
        ) : (
          <ul aria-label="Markers in order" className="max-h-72 overflow-y-auto flex flex-col gap-0.5">
            {markers.map((m) => (
              <MarkerListRow key={m.id} marker={m} meterMap={meterMap} pickupSteps={pickupSteps} onJump={onJump} />
            ))}
          </ul>
        )}
      </DockFlyout>
    </>
  );
}

/** One marker in the jump list: its bar (the jump), its name, its kind and a remove key. */
function MarkerListRow({
  marker,
  meterMap,
  pickupSteps,
  onJump,
}: {
  marker: RollMarker;
  meterMap: MeterSegment[];
  pickupSteps: number;
  onJump: (step: number) => void;
}) {
  const [draft, setDraft] = useState(marker.name);
  useEffect(() => setDraft(marker.name), [marker.name]);
  const nameId = `roll-marker-name-${marker.id}`;
  const kindId = `roll-marker-kind-${marker.id}`;
  const bar = markerBarLabel(marker, meterMap, pickupSteps);
  const commit = () => {
    if (draft !== marker.name) usePianoRollStore.getState().updateMarker(marker.id, { name: draft });
  };
  return (
    <li className="flex items-center gap-1" data-marker-row={marker.id}>
      <button
        type="button"
        onClick={() => onJump(markerStep(marker))}
        aria-label={`Jump to ${markerSpoken(marker, meterMap, pickupSteps)}`}
        className={`w-18 shrink-0 h-5.5 px-1.5 rounded-xs text-left text-[12px] font-bold tabular-nums whitespace-nowrap ${keyTone({})}`}
      >
        {bar}
      </button>
      <label htmlFor={nameId} className="sr-only">
        Name of the {kindWord(marker.kind).toLowerCase()} at {bar.toLowerCase()}
      </label>
      <input
        id={nameId}
        name={nameId}
        type="text"
        maxLength={MARKER_NAME_MAX}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(marker.name);
        }}
        className="flex-1 min-w-0 h-5.5 px-1.5 rounded-xs bg-white/5 border border-white/10 text-[12px] font-bold et-ink outline-none focus:border-[rgb(var(--et-accent))]"
      />
      <label htmlFor={kindId} className="sr-only">
        Kind of the marker {marker.name}
      </label>
      <select
        id={kindId}
        name={kindId}
        value={marker.kind}
        onChange={(e) => usePianoRollStore.getState().updateMarker(marker.id, { kind: e.target.value as RollMarkerKind })}
        className="h-5.5 shrink-0 px-1 rounded-xs bg-white/5 border border-white/10 text-[12px] font-bold et-ink cursor-pointer"
      >
        <option value="section">Section</option>
        <option value="movement">Movement</option>
      </select>
      <button
        type="button"
        onClick={() => usePianoRollStore.getState().removeMarker(marker.id)}
        aria-label={`Remove the ${kindWord(marker.kind).toLowerCase()} ${marker.name}`}
        title="Remove this marker"
        className={`${MINI_ICON_KEY} ${keyTone({})}`}
      >
        <X aria-hidden="true" className="w-3 h-3" />
      </button>
    </li>
  );
}
