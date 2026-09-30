/**
 * The articulation lane: the marker strip under the piano roll that shows
 * how each passage of the part being edited is played, and sets it.
 *
 * Each run of notes that share an articulation is one marker over the notes
 * it covers ("pizz." over a pizzicato passage, "arco" where a string part goes
 * back to the bow), as a score writes it once. A marker is a button: pressing
 * it selects its notes. The ARTICULATION field sets the selected notes'
 * articulation (Ordinario takes it away), one undo step; the line under it
 * says what that articulation plays as on this part's instrument
 * (lib/articulationMap: a string part's pizzicato is GM 46 Pizzicato Strings
 * on a channel of its own, or its sound bank's own "Violins Pizzicato" when
 * the part plays a user bank's preset; a staccato plays half its written
 * length).
 */
import React, { useMemo } from 'react';
import { Music2 } from 'lucide-react';
import { activeTrackOf, usePianoRollStore } from '../../state/pianoRollStore';
import {
  ARTICULATIONS,
  ARTICULATION_LABELS,
  ARTICULATION_MARKS,
  ARTICULATION_SHAPES,
  ORDINARIO_MARK,
  articulationBankOf,
  articulationFamily,
  articulationRuns,
  isArticulation,
  soundfontArticulationTarget,
  type Articulation,
  type ArticulationInstrument,
} from '../../lib/articulationMap';
import { GM_NAMES } from '../../lib/gmInstruments';
import { useSoundBankStore } from '../../state/soundBankStore';
import { isPercussionPart } from '../../lib/rollTracks';
import { FIELD, FIELD_LEGEND, FIELD_SELECT, FIELD_VALUE, STRIP_GLYPH, StripKey } from './midiDockKit';

/** The strip's height in px: one line of 12px marks. */
export const ARTICULATION_LANE_HEIGHT = 24;

/**
 * What `art` plays as on `inst`, in words: the preset it switches to, named
 * as its bank lists it (`bankName` gives a user bank's name by id; a General
 * MIDI preset is named by its number), and how the note is shaped.
 */
export function articulationSoundText(art: Articulation | null, inst: ArticulationInstrument, bankName: (bankId: string) => string | undefined = () => undefined): string {
  if (!art) return 'Ordinario: the part’s own sound';
  const target = soundfontArticulationTarget(art, inst);
  const shape = ARTICULATION_SHAPES[art];
  const parts: string[] = [];
  if (target?.bankId) {
    const bank = bankName(target.bankId);
    parts.push(`${target.name ?? `preset ${target.program + 1}`} (${bank ? `${bank}, ` : ''}bank ${target.bank}) on a channel of its own`);
  } else if (target) parts.push(`GM ${target.program + 1} ${GM_NAMES[target.program] ?? ''} on a channel of its own`.trim());
  if (shape.lengthScale !== 1) parts.push(`${Math.round(shape.lengthScale * 100)}% of its written length`);
  if (shape.velocityDelta !== 0) parts.push(`${shape.velocityDelta > 0 ? '+' : ''}${shape.velocityDelta} velocity`);
  if (!parts.length) parts.push('the part’s own sound; a VST3 library switches with its keyswitch');
  return `${ARTICULATION_LABELS[art]}: ${parts.join(', ')}`;
}

interface ArticulationLaneProps {
  stepPx: number;
  totalSteps: number;
}

export const ArticulationLane: React.FC<ArticulationLaneProps> = ({ stepPx, totalSteps }) => {
  const notes = usePianoRollStore((s) => s.notes);
  const part = usePianoRollStore((s) => activeTrackOf(s));
  const selectedIds = usePianoRollStore((s) => s.selectedIds);
  const setArticulation = usePianoRollStore((s) => s.setArticulation);
  const setSelection = usePianoRollStore((s) => s.setSelection);

  const banks = useSoundBankStore((s) => s.banks);
  const bankName = (bankId: string) => banks.find((b) => b.id === bankId)?.name;

  const runs = useMemo(() => articulationRuns(notes), [notes]);
  // The part's bank decides whether a user bank's own articulation presets are named; `banks` keeps the line current when the list changes.
  const inst: ArticulationInstrument = { instrumentId: part.instrumentId, program: part.program, percussion: isPercussionPart(part), ...articulationBankOf(part.bank) };
  const strings = articulationFamily(inst) === 'strings';
  const selected = notes.filter((n) => selectedIds.has(n.id));
  // The selection's articulation when every selected note shares one.
  const shared = selected.length && selected.every((n) => n.articulation === selected[0].articulation) ? (selected[0].articulation ?? '') : null;
  const width = Math.max(1, totalSteps * stepPx);
  const selectId = `articulation-lane-${part.id}`;
  const soundText = shared === null ? 'The selected notes have more than one articulation' : articulationSoundText(isArticulation(shared) ? shared : null, inst, bankName);

  return (
    <div className="shrink-0 border-t border-white/8 bg-black/30" data-articulation-lane>
      <div className="h-6.5 flex items-center gap-1.5 px-1.5 border-b border-white/5">
        <span className={FIELD_LEGEND}>Articulation</span>
        <div className={FIELD}>
          <label htmlFor={selectId} className={FIELD_LEGEND}>Selected</label>
          <select
            id={selectId}
            name={selectId}
            value={shared ?? 'mixed'}
            disabled={!selected.length}
            onChange={(e) => setArticulation(selectedIds, isArticulation(e.target.value) ? e.target.value : null)}
            className={FIELD_SELECT}
          >
            {shared === null && selected.length > 0 && <option value="mixed">Mixed</option>}
            <option value="">{strings ? 'Ordinario (arco)' : 'Ordinario'}</option>
            {ARTICULATIONS.map((a) => (
              <option key={a} value={a}>{ARTICULATION_LABELS[a]}</option>
            ))}
          </select>
        </div>
        <span className={FIELD_VALUE} role="status">
          {selected.length ? soundText : 'Select notes to mark them'}
        </span>
      </div>
      <div className="relative" style={{ width, height: ARTICULATION_LANE_HEIGHT }} role="group" aria-label={`Articulations of ${part.name}`}>
        {runs.map((r, i) => {
          // An ordinario run gets a marker only where it follows another articulation ("arco").
          if (!r.articulation && i === 0) return null;
          const mark = r.articulation ? ARTICULATION_MARKS[r.articulation] : strings ? 'arco' : ORDINARIO_MARK;
          const name = r.articulation ? ARTICULATION_LABELS[r.articulation] : strings ? 'Arco' : 'Ordinario';
          const left = r.startStep * stepPx;
          return (
            <button
              key={`${r.startStep}-${r.ids[0]}`}
              type="button"
              onClick={() => setSelection(r.ids)}
              aria-label={`${name}, ${r.ids.length} note${r.ids.length === 1 ? '' : 's'}: select them`}
              className={`absolute top-0.5 h-5 px-1 rounded-xs text-[12px] font-bold italic whitespace-nowrap overflow-hidden text-left border ${r.articulation ? 'border-[rgb(var(--et-accent))]/60 bg-[rgb(var(--et-accent))]/15 et-ink' : 'border-white/10 bg-white/5 et-ink-2'}`}
              style={{ left, width: Math.max(28, (r.endStep - r.startStep) * stepPx) }}
            >
              {mark}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/**
 * ART: opens the articulation lane under the grid. It latches like BEND, and
 * counts the part's marked notes so a part with pizzicato says so with the
 * lane closed.
 */
export const PianoRollArticulationKey: React.FC<{ on: boolean; onChange: (on: boolean) => void }> = ({ on, onChange }) => {
  const marked = usePianoRollStore((s) => s.notes.filter((n) => n.articulation).length);
  return (
    <StripKey
      on={on}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      iconOnly
      legend="Art"
      aria-label="Articulations"
      icon={<Music2 className={STRIP_GLYPH} />}
      description={
        marked > 0
          ? `Articulation lane under the grid: ${marked} note${marked === 1 ? ' is' : 's are'} marked in this part (pizzicato, staccato, tremolo and the rest).`
          : 'Articulation lane under the grid: mark notes legato, staccato, pizzicato, tremolo, marcato, spiccato, col legno, harmonics or con sordino'
      }
    />
  );
};
