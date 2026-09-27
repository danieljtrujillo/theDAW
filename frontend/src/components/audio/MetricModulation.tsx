/**
 * MODULATE: a metric modulation written into the roll's tempo map. The key
 * opens a card with the equation a score writes over the bar line, "dotted
 * quarter = quarter", and the tempo it gives from the tempo in force there
 * (lib/metricModulation). ADD TEMPO puts that tempo on the bar line as a tempo
 * change, which undo takes back like any tempo point.
 *
 * Two homes: the TEMPO lane's row, where a BAR field picks the bar (the bar
 * under the playhead to start with), and the METER face beside ADD, where it
 * is the selected meter change's bar, so a change into 12/8 and the dotted
 * quarter it takes its pulse from go in together.
 */
import React from 'react';
import { Equal } from 'lucide-react';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { logInfo } from '../../state/logStore';
import { barAt, barStartStep } from '../../lib/meterMap';
import { NOTE_VALUES, equationText, metricModulation, noteValue } from '../../lib/metricModulation';
import { tempoText } from '../../lib/tempoLane';
import { DockFlyout, FLYOUT_CARD, FLYOUT_KEY, FLYOUT_LEGEND, KEY_REST, MINI_GLYPH, MINI_ICON_KEY, STRIP_GLYPH, StripKey } from './midiDockKit';

/** The equation last used, for the next card: dotted quarter = quarter to start with. */
let lastBefore = 'dotted-quarter';
let lastAfter = 'quarter';

const selectClass =
  'h-5.5 bg-black/50 border border-white/10 rounded-xs px-1 text-[12px] font-semibold et-ink tabular-nums outline-none cursor-pointer';

interface MetricModulationKeyProps {
  /** Unique within the page: names the card and its fields. */
  idBase: string;
  /** The bar (0-based) the modulation starts on. Absent, the card's BAR field picks it. */
  bar?: number;
  /** A 20px key inside a lane row, else a strip key. */
  mini?: boolean;
  /** Where a result is reported besides the LOG. */
  onStatus?: (text: string) => void;
}

/** The bar a card without a fixed bar opens on: the bar under the playhead, or bar 2 from bar 1. */
const playheadBar = (): number => {
  const r = usePianoRollStore.getState();
  return Math.max(1, barAt(r.meterMap, Math.max(0, r.currentStep), r.pickupSteps).bar);
};

export const MetricModulationKey: React.FC<MetricModulationKeyProps> = ({ idBase, bar, mini = false, onStatus }) => {
  const keyRef = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [before, setBefore] = React.useState(lastBefore);
  const [after, setAfter] = React.useState(lastAfter);
  const [pickedBar, setPickedBar] = React.useState<number>(() => bar ?? playheadBar());
  const tempoMap = usePianoRollStore((s) => s.tempoMap);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const addTempoEvent = usePianoRollStore((s) => s.addTempoEvent);

  const atBar = bar ?? pickedBar;
  const startStep = barStartStep(meterMap, atBar, pickupSteps);
  const beat = startStep / 4;
  const lastBar = Math.max(1, barAt(meterMap, Math.max(0, totalSteps - 1e-6), pickupSteps).bar);
  const fixedAtStart = bar !== undefined && bar <= 0;
  const pastEnd = startStep >= totalSteps - 1e-9;
  const blocked = fixedAtStart || pastEnd || atBar < 1;
  const b = noteValue(before);
  const a = noteValue(after);
  const mod = metricModulation(tempoMap, beat, b, a);
  const replaces = tempoMap.some((e) => !e.fermata && e.beat === beat);
  const cardId = `${idBase}-card`;
  const why = fixedAtStart
    ? 'Bar 1 holds the starting tempo; select a later meter change to modulate into it'
    : pastEnd
      ? `Bar ${atBar + 1} starts after the roll ends`
      : `Metric modulation at bar ${atBar + 1}: ${equationText(b, a)} makes ${tempoText(mod.from)} BPM into ${tempoText(mod.bpm)}`;

  const openCard = (): void => {
    if (!open && bar === undefined) setPickedBar(playheadBar());
    setOpen((v) => !v);
  };

  const apply = (): void => {
    if (blocked) return;
    addTempoEvent({ beat, bpm: mod.bpm, curve: 'step' });
    const text = `Metric modulation at bar ${atBar + 1}: ${equationText(b, a)}, ${tempoText(mod.from)} to ${tempoText(mod.bpm)} BPM${mod.clamped ? ` (${tempoText(Math.round(mod.exact * 100) / 100)} is outside 20-300)` : ''}`;
    logInfo('midi', text);
    onStatus?.(text);
    setOpen(false);
  };

  return (
    <>
      <StripKey
        ref={keyRef}
        iconOnly
        mini={mini}
        onClick={openCard}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={cardId}
        aria-label="Metric modulation"
        description={why}
        on={open}
        icon={<Equal className={mini ? MINI_GLYPH : STRIP_GLYPH} />}
        legend="Modulate"
        className={mini ? MINI_ICON_KEY : undefined}
      />
      <DockFlyout
        open={open}
        anchorRef={keyRef}
        onClose={() => setOpen(false)}
        placement="above"
        align="start"
        ceilingSelector="[data-dock-ceiling]"
        floorSelector="[data-dock-floor]"
        id={cardId}
        role="dialog"
        aria-label="Metric modulation"
        className={`w-90 max-w-[92vw] ${FLYOUT_CARD}`}
      >
        <div className="flex flex-col gap-1.5 p-2">
          <div className="flex items-center gap-2 pb-1 border-b border-white/8">
            <span className="text-[12px] font-display font-extrabold uppercase et-ink">Modulate</span>
            <span className="text-[12px] font-semibold et-ink-2">
              {bar === undefined ? 'a new tempo from a note value' : `at bar ${atBar + 1}, the selected change`}
            </span>
          </div>
          {bar === undefined && (
            <div className="flex items-center gap-1.5">
              <label htmlFor={`${idBase}-bar`} className={`${FLYOUT_LEGEND} w-14`}>Bar</label>
              <input
                id={`${idBase}-bar`}
                name={`${idBase}-bar`}
                type="number"
                min={2}
                max={lastBar + 1}
                step={1}
                value={pickedBar + 1}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) setPickedBar(Math.max(1, Math.min(lastBar, v - 1)));
                }}
                className={`${selectClass} w-14`}
              />
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <label htmlFor={`${idBase}-before`} className={`${FLYOUT_LEGEND} w-14`}>Before</label>
            <select
              id={`${idBase}-before`}
              name={`${idBase}-before`}
              value={before}
              onChange={(e) => {
                setBefore(e.target.value);
                lastBefore = e.target.value;
              }}
              title="The note value at the tempo before the bar line"
              className={selectClass}
            >
              {NOTE_VALUES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <span aria-hidden="true" className="text-[12px] font-bold et-ink">=</span>
            <label htmlFor={`${idBase}-after`} className={FLYOUT_LEGEND}>After</label>
            <select
              id={`${idBase}-after`}
              name={`${idBase}-after`}
              value={after}
              onChange={(e) => {
                setAfter(e.target.value);
                lastAfter = e.target.value;
              }}
              title="The note value that lasts as long at the new tempo"
              className={selectClass}
            >
              {NOTE_VALUES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <p className="text-[12px] font-bold et-ink leading-snug" role="status">
            {blocked
              ? why
              : `${tempoText(mod.from)} BPM becomes ${tempoText(mod.bpm)} BPM at bar ${atBar + 1}${mod.clamped ? `, held to the 20-300 range (${tempoText(Math.round(mod.exact * 100) / 100)} exactly)` : ''}${replaces ? '. It replaces the tempo point on that bar line.' : '.'}`}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={apply}
              disabled={blocked}
              className={`${FLYOUT_KEY} ${KEY_REST} disabled:opacity-40`}
            >
              <Equal aria-hidden="true" className="w-3 h-3" />
              <span>Add tempo</span>
            </button>
          </div>
        </div>
      </DockFlyout>
    </>
  );
};
