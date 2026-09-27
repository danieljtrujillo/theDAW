/**
 * RollSnapControls — the MIDI strip's SNAP select and TUPLET key.
 *
 *   SNAP    the grid a click, a note drag, a resize, an arrow nudge, the note
 *           menu and a paste land on, and the subdivision the grid draws:
 *           1/4 to 1/64, triplets, quintuplets, septuplets, dotted 8ths, or
 *           the meter's own groups. Every grid restarts on each group of each
 *           bar (lib/rollSnap).
 *   TUPLET  respaces the selected notes N in the time of M straight notes of
 *           the snap's unit (5 in 4 16ths), from the first selected note, in
 *           one undo step.
 *
 * The snap is a roll setting, persisted with the store's other settings.
 */
import React from 'react';
import { ArrowLeftToLine, ArrowRightToLine, Divide, Send } from 'lucide-react';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { logInfo, logWarn } from '../../state/logStore';
import {
  ROLL_SNAPS,
  TUPLET_M_MAX,
  TUPLET_M_MIN,
  TUPLET_N_MAX,
  TUPLET_N_MIN,
  defaultTupletM,
  isRollSnapId,
  rollSnapDef,
  selectedOnsets,
  tupletUpdates,
} from '../../lib/rollSnap';
import { PPQ } from '../../lib/noteClock';
import { DockFlyout, FIELD, FIELD_LEGEND, FIELD_SELECT, FLYOUT_CARD, FLYOUT_LEGEND, MINI_GLYPH, STRIP_GLYPH, StripKey } from './midiDockKit';
import { Stepper } from './MeterFace';

/** A straight unit in words, plural: what TUPLET's M counts. */
const UNIT_WORDS: Record<number, string> = {
  [PPQ]: 'quarters',
  [PPQ / 2]: '8ths',
  [PPQ / 4]: '16ths',
  [PPQ / 8]: '32nds',
  [PPQ / 16]: '64ths',
};
const unitWord = (ticks: number): string => UNIT_WORDS[ticks] ?? `${ticks}-tick notes`;

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

export const RollSnapControls: React.FC = () => {
  const snap = usePianoRollStore((s) => s.snap);
  const setSnap = usePianoRollStore((s) => s.setSnap);
  const def = rollSnapDef(snap);
  // The selection's onsets: TUPLET's default N, and whether it has anything to respace.
  // Counted from the two slices, so the playhead's writes never recount them.
  const notes = usePianoRollStore((s) => s.notes);
  const selectedIds = usePianoRollStore((s) => s.selectedIds);
  const onsetCount = React.useMemo(() => (selectedIds.size ? selectedOnsets(notes, selectedIds).length : 0), [notes, selectedIds]);

  const keyRef = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  // N and M the user set; null follows the selection (N) and the usual ratio for N (M).
  const [nSet, setN] = React.useState<number | null>(null);
  const [mSet, setM] = React.useState<number | null>(null);
  const n = nSet ?? clampInt(Math.max(onsetCount, 3), TUPLET_N_MIN, TUPLET_N_MAX);
  const m = mSet ?? defaultTupletM(n);
  const units = unitWord(def.unit);

  const apply = (): void => {
    const s = usePianoRollStore.getState();
    const updates = tupletUpdates(s.notes, s.selectedIds, n, m, def.unit);
    if (updates.length === 0) {
      logWarn('piano-roll', 'Tuplet: select the notes to respace first');
      return;
    }
    s.setNoteTimes(updates);
    logInfo('piano-roll', `Tuplet: ${updates.length} note${updates.length === 1 ? '' : 's'} respaced ${n} in the time of ${m} ${units}`);
  };

  return (
    <>
      <div className={FIELD} title="Snap: the grid a click, a note drag, a resize, the arrow keys, the note menu and a paste land on. Each grid restarts on every group of every bar.">
        <label htmlFor="piano-roll-snap" className={FIELD_LEGEND}>Snap</label>
        <select
          id="piano-roll-snap"
          name="piano-roll-snap"
          value={snap}
          onChange={(e) => {
            if (isRollSnapId(e.target.value)) setSnap(e.target.value);
          }}
          className={`${FIELD_SELECT} max-w-28`}
        >
          {ROLL_SNAPS.map((d) => (
            <option key={d.id} value={d.id} title={d.title}>{d.label}</option>
          ))}
        </select>
      </div>
      <StripKey
        ref={keyRef}
        iconOnly
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="piano-roll-tuplet"
        aria-label="Tuplet: respace the selected notes"
        description={`Tuplet: respace the selected notes ${n} in the time of ${m} ${units}`}
        on={open}
        icon={<Divide className={STRIP_GLYPH} />}
        legend="Tuplet"
      />
      <DockFlyout
        open={open}
        anchorRef={keyRef}
        onClose={() => setOpen(false)}
        placement="below"
        align="start"
        floorSelector="[data-dock-floor]"
        id="piano-roll-tuplet"
        role="dialog"
        aria-label="Tuplet: respace the selected notes"
        className={`w-72 max-w-[92vw] p-2 flex flex-col gap-1.5 ${FLYOUT_CARD}`}
      >
        <span className="text-[12px] font-display font-extrabold uppercase et-ink">Tuplet</span>
        <div className="flex items-center gap-2 flex-wrap">
          <Stepper
            flyout
            id="piano-roll-tuplet-n"
            legend="Notes"
            title={`Notes in the tuplet (${TUPLET_N_MIN}-${TUPLET_N_MAX}); it follows the selection until set`}
            value={String(n)}
            valueClass="min-w-5"
            downLabel="Fewer notes in the tuplet"
            upLabel="More notes in the tuplet"
            downDisabled={n <= TUPLET_N_MIN}
            upDisabled={n >= TUPLET_N_MAX}
            onStep={(dir) => {
              setN(clampInt(n + dir, TUPLET_N_MIN, TUPLET_N_MAX));
              setM(null);
            }}
          />
          <Stepper
            flyout
            id="piano-roll-tuplet-m"
            legend="In"
            title={`The straight ${units} the tuplet fills (${TUPLET_M_MIN}-${TUPLET_M_MAX})`}
            value={String(m)}
            valueClass="min-w-5"
            downLabel="Fewer straight notes"
            upLabel="More straight notes"
            downIcon={<ArrowLeftToLine className={MINI_GLYPH} />}
            upIcon={<ArrowRightToLine className={MINI_GLYPH} />}
            downDisabled={m <= TUPLET_M_MIN}
            upDisabled={m >= TUPLET_M_MAX}
            onStep={(dir) => setM(clampInt(m + dir, TUPLET_M_MIN, TUPLET_M_MAX))}
          />
          <span className={FLYOUT_LEGEND} title={`The unit follows the snap (${def.label})`}>{units}</span>
        </div>
        <p className="text-[12px] font-semibold et-ink-2">
          {onsetCount === 0
            ? 'Select the notes to respace.'
            : `${onsetCount} selected onset${onsetCount === 1 ? '' : 's'}: ${n} in the time of ${m} ${units} from the first one.`}
        </p>
        <div className="flex items-center gap-2 pt-1 border-t border-white/8">
          <StripKey
            flyout
            on
            onClick={apply}
            disabled={onsetCount === 0}
            aria-label={`Respace the selected notes ${n} in the time of ${m} ${units}`}
            description="One undo step; a chord moves as one"
            icon={<Send className="w-3 h-3" />}
            legend="Apply"
          />
        </div>
      </DockFlyout>
    </>
  );
};
