/**
 * CLEAN: the action rail's key for tidying a transcription in the part being
 * edited (lib/rollCleanup), on the selected notes when there are some, else
 * on every note of the part.
 *
 * Its card holds two tools, each with its own labelled controls and key:
 * ONE AT A TIME (keep the top line, the bottom line or the latest note where
 * notes overlap) and KEEP RANGE (a low and a high pitch; every note outside
 * them goes). The range starts at the part's registry instrument's range when
 * it has one (an electric bass's E1 to G4), else at the notes' own lowest and
 * highest pitch. Each tool is one undo step, keeps the notes it left
 * selected, and writes what it did to the LOG.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Eraser, ListFilter, SlidersVertical } from 'lucide-react';
import { activeTrackOf, usePianoRollStore } from '../../state/pianoRollStore';
import { orchestraInstrument, pitchLabel } from '../../lib/orchestra';
import { ONE_AT_A_TIME_LABELS, cleanRollNotes, rollCleanupLog, type RollCleanup } from '../../lib/rollCleanup';
import type { OneAtATimeKeep } from '../../lib/clipNotes';
import { logInfo } from '../../state/logStore';
import { DockFlyout, FIELD_LEGEND, FLYOUT_CARD, FLYOUT_SELECT, RAIL_GLYPH, RailKey, StripKey } from './midiDockKit';

const KEEPS: readonly OneAtATimeKeep[] = ['top', 'bottom', 'latest'];

/** What each ONE AT A TIME choice does, in its option's tooltip. */
const KEEP_HELP: Readonly<Record<OneAtATimeKeep, string>> = Object.freeze({
  top: 'Where notes overlap the higher one stays: a melody',
  bottom: 'Where notes overlap the lower one stays: a bass line',
  latest: 'Each note cuts the one before it, as a monophonic synth plays',
});

/** Clean the part being edited (lib/rollCleanup) in one undo step, keep the notes left selected, and say so in the LOG. */
export function runRollCleanup(cleanup: RollCleanup): number {
  const s = usePianoRollStore.getState();
  const res = cleanRollNotes(s.notes, s.selectedIds, cleanup);
  if (res.in === 0) return 0;
  if (res.removed > 0 || res.shortened > 0) {
    s.replaceAll(res.notes);
    if (res.scope === 'selection') usePianoRollStore.getState().setSelection(res.kept);
  }
  logInfo('piano-roll', rollCleanupLog(cleanup, res, pitchLabel));
  return res.removed + res.shortened;
}

/** The range KEEP RANGE starts at: the part's instrument's, else its notes' own. */
function startingRange(): { low: number; high: number } {
  const s = usePianoRollStore.getState();
  const inst = orchestraInstrument(activeTrackOf(s).instrumentId);
  if (inst && !inst.percussion) return { low: inst.rangeLow, high: inst.rangeHigh };
  const pitches = s.notes.map((n) => n.note);
  return pitches.length ? { low: Math.min(...pitches), high: Math.max(...pitches) } : { low: 21, high: 108 };
}

/** A pitch field (0-127) with its label and its note name. */
const PitchField: React.FC<{ id: string; label: string; value: number; onChange: (v: number) => void; title: string }> = ({ id, label, value, onChange, title }) => (
  <div className="flex flex-col gap-0.5 min-w-0">
    <label htmlFor={id} className={FIELD_LEGEND}>{label}</label>
    <div className="flex items-center gap-1.5">
      <input
        id={id}
        name={id}
        type="number"
        min={0}
        max={127}
        step={1}
        value={value}
        onChange={(e) => {
          const v = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(v)) onChange(Math.max(0, Math.min(127, v)));
        }}
        title={title}
        aria-describedby={`${id}-name`}
        className={`${FLYOUT_SELECT} w-14`}
      />
      <span id={`${id}-name`} className="text-[12px] font-bold et-ink tabular-nums">{pitchLabel(value)}</span>
    </div>
  </div>
);

export const PianoRollCleanKey: React.FC = () => {
  const count = usePianoRollStore((s) => s.notes.length);
  const selected = usePianoRollStore((s) => s.selectedIds.size);
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<OneAtATimeKeep>('top');
  const [range, setRange] = useState<{ low: number; high: number }>({ low: 21, high: 108 });
  const keyRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The range starts where the part plays each time the card opens.
  useEffect(() => {
    if (open) setRange(startingRange());
  }, [open]);
  const scope = selected > 0 ? `the ${selected} selected note${selected === 1 ? '' : 's'}` : `every note of the part (${count})`;
  return (
    <div ref={wrapRef} className="relative">
      <RailKey
        ref={keyRef}
        onClick={() => setOpen((o) => !o)}
        disabled={count === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="piano-roll-clean-card"
        aria-label={count ? 'Clean up the notes: one at a time, keep a range' : 'Clean up the notes: the part has none'}
        description="Tidy a transcription: reduce the notes to one line, or remove the notes outside a pitch range"
        icon={<Eraser className={RAIL_GLYPH} />}
        legend="Clean"
        on={open}
      />
      <DockFlyout
        open={open && count > 0}
        anchorRef={wrapRef}
        returnFocusRef={keyRef}
        onClose={() => setOpen(false)}
        placement="right"
        floorSelector="[data-dock-floor]"
        id="piano-roll-clean-card"
        role="dialog"
        aria-label="Clean up the notes"
        className={`w-60 p-2 flex flex-col gap-2 ${FLYOUT_CARD}`}
      >
        <p className="text-[12px] font-semibold et-ink-3">On {scope}.</p>
        <section aria-labelledby="piano-roll-clean-mono-title" className="flex flex-col gap-1.5">
          <h3 id="piano-roll-clean-mono-title" className="text-[12px] font-display font-bold uppercase et-ink">One at a time</h3>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="piano-roll-clean-keep" className={FIELD_LEGEND}>Keep</label>
            <select
              id="piano-roll-clean-keep"
              name="piano-roll-clean-keep"
              value={keep}
              onChange={(e) => setKeep(KEEPS.includes(e.target.value as OneAtATimeKeep) ? (e.target.value as OneAtATimeKeep) : 'top')}
              title={KEEP_HELP[keep]}
              className={FLYOUT_SELECT}
            >
              {KEEPS.map((k) => (
                <option key={k} value={k} title={KEEP_HELP[k]}>{ONE_AT_A_TIME_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <StripKey
            flyout
            onClick={() => runRollCleanup({ kind: 'one-at-a-time', keep })}
            aria-label={`One at a time: keep the ${ONE_AT_A_TIME_LABELS[keep].toLowerCase()} of ${scope}`}
            icon={<SlidersVertical className="w-3 h-3" />}
            legend="One at a time"
            className="self-start"
          />
        </section>
        <section aria-labelledby="piano-roll-clean-range-title" className="flex flex-col gap-1.5">
          <h3 id="piano-roll-clean-range-title" className="text-[12px] font-display font-bold uppercase et-ink">Keep range</h3>
          <div className="flex items-end gap-2">
            <PitchField
              id="piano-roll-clean-low"
              label="Low"
              value={range.low}
              onChange={(low) => setRange((r) => ({ ...r, low }))}
              title="The lowest pitch kept, as a MIDI note number"
            />
            <PitchField
              id="piano-roll-clean-high"
              label="High"
              value={range.high}
              onChange={(high) => setRange((r) => ({ ...r, high }))}
              title="The highest pitch kept, as a MIDI note number"
            />
          </div>
          <StripKey
            flyout
            onClick={() => runRollCleanup({ kind: 'keep-range', low: range.low, high: range.high })}
            aria-label={`Keep range: remove the notes below ${pitchLabel(Math.min(range.low, range.high))} or above ${pitchLabel(Math.max(range.low, range.high))} from ${scope}`}
            icon={<ListFilter className="w-3 h-3" />}
            legend="Keep range"
            className="self-start"
          />
        </section>
      </DockFlyout>
    </div>
  );
};
