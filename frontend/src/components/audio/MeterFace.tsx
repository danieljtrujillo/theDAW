/**
 * MeterFace — the SHAPE row's METER face: the piano roll's meter map, its
 * polymeter lanes and the syncopation amounts, inline on one row.
 *
 *   BARS    the selected meter change's bars, stepped change to change
 *   BEATS   its numerator (a compound meter starts in threes); the /1 to /32
 *           keys its unit; GROUPS its grouping, as keys for three choices or
 *           fewer and a menu for more; the grouping field takes any grouping
 *           typed as 3+3+2+1
 *   ADD     a change at the playhead's bar (off when that bar starts after the
 *           roll ends); the trash key removes the selected one; MODULATE puts
 *           a metric modulation on the selected change's bar line
 *           (MetricModulation.tsx)
 *   PICKUP  the steps before bar 1, a unit of the first meter at a time
 *   LANES   one key per lane in its roll look (a menu past five lanes); + adds
 *           a lane, the trash key removes the active one; TIME opens the
 *           active lane's own meter and tuplet ratio, whose bars and groups the
 *           grid draws and snaps to while the lane is active
 *   LOOP    the active lane's loop in steps (Shift steps a bar)
 *   SPAN    the active lane played only in the selected change's bars, or
 *           over the whole roll again
 *   SYNC / ACCENT  the Virtuoso amounts, their ranges widening into spare width
 *   GEN     LOOM's rules written into the active lane, from a flyout
 *   MATCH   the meter map, pickup, tempo, tempo changes, swing and lanes of
 *           the song in the strip
 *   TEMPO   the tempo changes MATCH wrote, lowest to highest, and a key that
 *           clears them (shown only while the roll has some)
 *
 * The logic is lib/meterFace.ts. Meter and lane edits write the store through
 * applyMeter, which ends the roll on a bar line. Map edits pass merge off:
 * merging a segment that repeats its neighbour's meter would take the selected
 * change away while BEATS steps through that meter. GEN and MATCH results go to
 * the MIDI tab's status line (`onStatus`) and the LOG.
 */
import React from 'react';
import { create } from 'zustand';
import {
  ArrowLeftToLine, ArrowRightToLine, AudioWaveform, Blocks, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, DiamondMinus, DiamondPlus, Dices,
  Eraser, ListPlus, ListX, Minus, Plus, Scissors, Send, Timer,
} from 'lucide-react';
import { laneName, usePianoRollStore, type LaneTimePatch } from '../../state/pianoRollStore';
import { useVirtuosoStore } from '../../state/virtuosoStore';
import { logError, logInfo, logWarn } from '../../state/logStore';
import { fetchRhythm } from '../../lib/rhythmSeed';
import { GEN_RULES } from '../../lib/rollLoom';
import { GEN_DEFAULT_OPTS, GEN_KINDS, type GenKind, type GenOpts } from '../../lib/loomGen';
import { normalizeMeterMap, stepsPerBar } from '../../lib/meterMap';
import {
  BEATS_MAX, BEATS_MIN, LANE_TUPLET_PRESETS, UNITS, addChange, addChangeBar, addChangePastEnd, clampSelection, formatOption, genOptionSpecs,
  genPreview, genStatus, genTarget, genWrite, groupChoices, groupsValue, laneBarSteps, laneForms, laneMeterChoices, laneMeterFromText, laneMeterFromValue,
  laneMeterValue, lanePitches, laneSpanLabel, laneTimeLabel, matchApply, matchError, meterLabel, newLaneCycle, parseGroupsValue, pickupLabel, pickupMax,
  removeChange, respanLane, segmentAtStep, segmentLabel, segmentSpan, setBeats, setGroupingText, setGroups, setUnit, canStepLaneTuplet, spanIsSegment,
  stepLaneTuplet, stepLoop, stepOption, stepPickup, tempoSummary, tupletLabel, writeMatch, type GateChoice, type GenSettings, type LaneForm, type MeterEdit,
} from '../../lib/meterFace';
import { TUPLET_RATIO_MAX, sanitizeTuplet } from '../../lib/meterMap';
import { hasTempoChanges } from '../../lib/rollTempo';
import {
  DockFlyout, FIELD, FIELD_GROW, FIELD_LEGEND, FIELD_SELECT, FIELD_VALUE, FLYOUT_CARD, FLYOUT_KEY, FLYOUT_LEGEND, FLYOUT_VALUE, KEY_REST,
  MINI_GLYPH, MINI_ICON_KEY, MINI_KEY, RANGE_FILL, STRIP_GLYPH, Sep, StripKey, keyTone,
} from './midiDockKit';
import { MetricModulationKey } from './MetricModulation';

type Level = 'info' | 'warn' | 'error';

/** MATCH can outlive the face (a flip to SHAPE mid-analysis), so its busy flag is shared. */
const useMatchBusy = create<{ busy: boolean }>(() => ({ busy: false }));

/** GROUPS draws keys up to this many choices, and a menu past it. */
const GROUP_KEYS_MAX = 3;
/** LANES draws a key per lane up to this many lanes, and a menu past it, so the
 *  row keeps its width however many lanes are added. */
const LANE_KEYS_MAX = 5;

/* ── lane swatches: PianoRoll.tsx's lane forms, in the one accent ─────────── */

const accentStripes = (angle: number): React.CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(${angle}deg, rgb(var(--et-accent)) 0 2px, rgb(var(--et-accent) / 0.16) 2px 4px)`,
});
const SWATCH: Record<LaneForm, { className: string; style?: React.CSSProperties }> = {
  solid: { className: 'bg-[rgb(var(--et-accent))] border-black/40' },
  outline: { className: 'bg-[rgb(var(--et-accent)/0.14)] border-[rgb(var(--et-accent))]' },
  stripe: { className: 'border-[rgb(var(--et-accent)/0.8)]', style: accentStripes(135) },
  hatch: {
    className: 'bg-[rgb(var(--et-accent)/0.14)] border-[rgb(var(--et-accent))]',
    style: { backgroundImage: 'repeating-linear-gradient(45deg, rgb(var(--et-accent) / 0.55) 0 1px, transparent 1px 5px)' },
  },
  stripe45: { className: 'border-[rgb(var(--et-accent)/0.8)]', style: accentStripes(45) },
};

const LaneSwatch: React.FC<{ form: LaneForm }> = ({ form }) => (
  <span aria-hidden="true" className={`w-3 h-2 shrink-0 rounded-xs border ${SWATCH[form].className}`} style={SWATCH[form].style} />
);

/* ── a legend, a minus key, the value, a plus key ─────────────────────────── */

interface StepperProps {
  id: string;
  legend?: string;
  /** What the field holds: the legend's and readout's title, and each key's DockTip description. */
  title: string;
  value: string;
  downLabel: string;
  upLabel: string;
  /** The keys' glyphs, minus and plus by default. A second stepper in the same row
   *  passes its own pair, so no two keys in the row share a glyph. */
  downIcon?: React.ReactNode;
  upIcon?: React.ReactNode;
  /** `byBar` is true on a Shift-click. */
  onStep: (dir: -1 | 1, byBar: boolean) => void;
  downDisabled?: boolean;
  upDisabled?: boolean;
  valueClass?: string;
  /** Inside the GEN card: the 12px legend and readout. */
  flyout?: boolean;
}

/** The −/+ keys are one control with the readout between them, named by their
 *  own DockTips; the field carries no title, so no key shows two tooltips. A key
 *  its press takes to the limit passes keyboard focus to its pair. */
export const Stepper: React.FC<StepperProps> = ({ id, legend, title, value, downLabel, upLabel, downIcon, upIcon, onStep, downDisabled, upDisabled, valueClass = 'min-w-4', flyout }) => (
  <div className={FIELD}>
    {legend && <span className={flyout ? FLYOUT_LEGEND : FIELD_LEGEND} title={title}>{legend}</span>}
    <StripKey
      mini
      iconOnly
      aria-label={downLabel}
      aria-describedby={`${id}-value`}
      description={title}
      disabled={downDisabled}
      passFocusOnDisable
      onClick={(e) => onStep(-1, e.shiftKey)}
      icon={downIcon ?? <Minus className={MINI_GLYPH} />}
      legend={downLabel}
    />
    <span id={`${id}-value`} aria-live="polite" title={title} className={`${flyout ? FLYOUT_VALUE : FIELD_VALUE} ${valueClass}`}>{value}</span>
    <StripKey
      mini
      iconOnly
      aria-label={upLabel}
      aria-describedby={`${id}-value`}
      description={title}
      disabled={upDisabled}
      passFocusOnDisable
      onClick={(e) => onStep(1, e.shiftKey)}
      icon={upIcon ?? <Plus className={MINI_GLYPH} />}
      legend={upLabel}
    />
  </div>
);

/* ── GEN settings, kept across face flips for the session ─────────────────── */

type GateKind = GateChoice['kind'];

interface GenUi {
  kind: GenKind;
  optsByKind: Record<GenKind, GenOpts>;
  /** A steps value the user set, and the pass length it was set for; a new pass length follows it again. */
  steps: { value: number; forLen: number } | null;
  gate: GateKind;
  pct: number;
  period: number;
  laps: number[];
  seed: number;
}

const freshGenUi = (): GenUi => ({
  kind: 'euclid',
  optsByKind: Object.fromEntries(GEN_KINDS.map((k) => [k, { ...GEN_DEFAULT_OPTS[k] }])) as Record<GenKind, GenOpts>,
  steps: null,
  gate: 'open',
  pct: 70,
  period: 2,
  laps: [1],
  seed: 4821,
});

let genMemory: GenUi | null = null;

const GATE_KEYS: Array<{ kind: GateKind; legend: string; title: string }> = [
  { kind: 'open', legend: 'Open', title: 'Open: every step the rule plays is written' },
  { kind: 'chance', legend: 'Chance', title: "Chance: each step plays when LOOM's seeded die lands under the percent" },
  { kind: 'lap', legend: 'Lap', title: 'Lap: only the chosen passes of every period play' },
];

/** What each unit key means; its accessible name is the printed "/4" followed by this. */
const UNIT_NAMES: Record<number, string> = {
  1: 'Whole-note beat',
  2: 'Half-note beat',
  4: 'Quarter-note beat',
  8: 'Eighth-note beat',
  16: 'Sixteenth-note beat',
  32: 'Thirty-second-note beat',
};

const barsText = (first: number, last: number): string => (first === last ? `${first + 1}` : `${first + 1}-${last + 1}`);

interface MeterFaceProps {
  /** The library entry in the strip's song field, whose rhythm analysis MATCH reads. */
  songEntryId?: string;
  /** The MIDI tab's status line. */
  onStatus?: (text: string) => void;
}

export const MeterFace: React.FC<MeterFaceProps> = ({ songEntryId, onStatus }) => {
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lanes = usePianoRollStore((s) => s.lanes);
  const activeLane = usePianoRollStore((s) => s.activeLane);
  const tempoMap = usePianoRollStore((s) => s.tempoMap);
  const rollBpm = usePianoRollStore((s) => s.bpm);
  // Numbers, so the playhead re-renders the face only when ADD's bar changes.
  const addBar = usePianoRollStore((s) => addChangeBar(s.meterMap, s.currentStep, s.pickupSteps));
  const addPastEnd = usePianoRollStore((s) => addChangePastEnd(s.meterMap, s.currentStep, s.pickupSteps, s.totalSteps));
  const sync = useVirtuosoStore((s) => s.amounts.sync);
  const accent = useVirtuosoStore((s) => s.amounts.accent);
  const setAmount = useVirtuosoStore((s) => s.setAmount);
  const keyV = useVirtuosoStore((s) => s.key);
  const modeV = useVirtuosoStore((s) => s.mode);
  const matchBusy = useMatchBusy((s) => s.busy);

  /** A result for the status line and the LOG. */
  const post = (text: string, level: Level = 'info'): void => {
    onStatus?.(text);
    (level === 'error' ? logError : level === 'warn' ? logWarn : logInfo)('midi', text);
  };

  const segs = React.useMemo(() => normalizeMeterMap(meterMap, false), [meterMap]);
  // The selection opens on the segment under the playhead and is clamped on
  // every render, so removed segments never leave it pointing past the end.
  const [sel, setSel] = React.useState(() => {
    const r = usePianoRollStore.getState();
    return segmentAtStep(r.meterMap, r.currentStep, r.pickupSteps);
  });
  const selected = clampSelection(segs, sel);
  const seg = segs[selected];
  const meter = seg.meter;
  const lane = lanes.find((l) => l.id === activeLane) ?? lanes[0];
  const forms = React.useMemo(() => laneForms(lanes, activeLane), [lanes, activeLane]);

  const writeMap = (edit: MeterEdit): void => {
    usePianoRollStore.getState().applyMeter({ meterMap: edit.meterMap }, false);
    setSel(edit.selected);
  };

  const onAdd = (): void => {
    const r = usePianoRollStore.getState();
    if (addChangePastEnd(r.meterMap, r.currentStep, r.pickupSteps, r.totalSteps)) return;
    writeMap(addChange(r.meterMap, selected, r.currentStep, r.pickupSteps));
  };
  const onRemove = (): void => {
    const edit = removeChange(usePianoRollStore.getState().meterMap, selected);
    if (edit) writeMap(edit);
  };

  const onAddLane = (): void => {
    const r = usePianoRollStore.getState();
    const id = r.lanes.reduce((m, l) => Math.max(m, l.id), 0) + 1;
    r.applyMeter({ lanes: [...r.lanes, { id, name: laneName(id), cycleSteps: newLaneCycle(r.meterMap) }] });
    r.setActiveLane(id);
  };
  // removeLane also moves the lane's notes into lane A, which applyMeter does not touch.
  const onRemoveLane = (): void => {
    const r = usePianoRollStore.getState();
    if (r.activeLane !== 0) r.removeLane(r.activeLane);
  };
  /* TIME: the active lane's own meter and tuplet ratio. */
  const timeKeyRef = React.useRef<HTMLButtonElement>(null);
  const [timeOpen, setTimeOpen] = React.useState(false);
  const laneRatio = sanitizeTuplet(lane.tuplet);
  const ratioNow = laneRatio ?? { n: 1, m: 1 };
  const laneBar = laneBarSteps(lane, segs, pickupSteps);
  const setLaneTime = (time: LaneTimePatch): void => {
    const r = usePianoRollStore.getState();
    if (r.activeLane === 0) return;
    r.setLaneTime(r.activeLane, time);
  };
  // The typed lane meter: a draft while typed, applied on Enter or when it loses focus.
  const [laneMeterDraft, setLaneMeterDraft] = React.useState<string | null>(null);
  React.useEffect(() => setLaneMeterDraft(null), [lane]);
  const commitLaneMeter = (): void => {
    if (laneMeterDraft === null) return;
    const map = laneMeterFromText(laneMeterDraft);
    if (map === undefined) {
      post(`"${laneMeterDraft}" IS NOT A METER. TYPE BEATS/UNIT, SUCH AS 11/16, WITH GROUPS AFTER A SPACE, SUCH AS 11/16 3+3+3+2.`, 'warn');
      return;
    }
    setLaneMeterDraft(null);
    setLaneTime({ meterMap: map });
  };
  // Lane A has no time of its own, so the card closes when A becomes the active lane.
  React.useEffect(() => {
    if (activeLane === 0) setTimeOpen(false);
  }, [activeLane]);

  const onLoop = (dir: -1 | 1, byBar: boolean): void => {
    const r = usePianoRollStore.getState();
    const l = r.lanes.find((x) => x.id === r.activeLane);
    if (!l || l.id === 0) return;
    // Shift steps one bar: the lane's own bar when it keeps a time of its own.
    const cycleSteps = stepLoop(l.cycleSteps, dir, byBar, laneBarSteps(l, r.meterMap, r.pickupSteps) ?? stepsPerBar(meter), r.totalSteps);
    r.applyMeter({ lanes: r.lanes.map((x) => (x.id === l.id ? { ...x, cycleSteps } : x)) });
  };
  // The lane's notes and bends move with its loop's first cycle; the writes fold into one undo step.
  const onSpan = (): void => {
    const r = usePianoRollStore.getState();
    if (r.activeLane === 0) return;
    const next = respanLane(r, selected, r.activeLane);
    r.applyMeter({ lanes: next.lanes });
    if (next.notes) r.replaceAll(next.notes);
    if (next.bends) r.setBends(next.bends);
  };

  /* GEN */
  const genKeyRef = React.useRef<HTMLButtonElement>(null);
  const [genOpen, setGenOpen] = React.useState(false);
  const [gen, setGenState] = React.useState<GenUi>(() => genMemory ?? freshGenUi());
  const setGen = (patch: Partial<GenUi>): void =>
    setGenState((prev) => {
      const next = { ...prev, ...patch };
      genMemory = next;
      return next;
    });

  const target = genTarget({ meterMap: segs, pickupSteps, lanes, activeLane, totalSteps }, selected);
  const autoSteps = Math.max(1, Math.round(target.passLen));
  const ruleSteps = gen.steps && gen.steps.forLen === target.passLen ? gen.steps.value : autoSteps;
  const gate: GateChoice =
    gen.gate === 'chance' ? { kind: 'chance', pct: gen.pct } : gen.gate === 'lap' ? { kind: 'lap', period: gen.period, laps: gen.laps } : { kind: 'open' };
  const opts = gen.optsByKind[gen.kind];
  const settings: GenSettings = { kind: gen.kind, opts, steps: ruleSteps, gate, seed: gen.seed };
  const pitches = React.useMemo(() => lanePitches(keyV, modeV), [keyV, modeV]);
  const preview = genOpen ? genPreview(settings, pitches, target.lane) : [];
  const previewHits = preview.filter(Boolean).length;
  const targetRange = target.bars ? barsText(target.bars.first, target.bars.last) : String(target.cycle);
  const targetTitle = target.bars
    ? `Writes bars ${barsText(target.bars.first, target.bars.last)} of lane ${target.name}, one rule pass per bar`
    : `Writes one ${target.cycle}-step cycle of lane ${target.name}, which repeats with the lane`;

  const setOpt = (key: string, value: number): void => {
    if (key === 'steps') setGen({ steps: { value, forLen: target.passLen } });
    else setGen({ optsByKind: { ...gen.optsByKind, [gen.kind]: { ...opts, [key]: value } } });
  };

  const onWrite = (): void => {
    const r = usePianoRollStore.getState();
    const res = genWrite(r, selected, settings, pitches, `gen-${Date.now().toString(36)}`);
    r.replaceAll(res.notes);
    post(genStatus(res.written, res.target.name), res.written ? 'info' : 'warn');
  };

  /* MATCH */
  const onMatch = async (): Promise<void> => {
    if (!songEntryId || useMatchBusy.getState().busy) return;
    useMatchBusy.setState({ busy: true });
    onStatus?.("MATCH IS READING THE SONG'S RHYTHM.");
    try {
      const analysis = await fetchRhythm(songEntryId, { run: true });
      const r = usePianoRollStore.getState();
      const res = matchApply(r, analysis);
      if (res.apply) {
        writeMatch(r, res.apply);
        const after = usePianoRollStore.getState();
        setSel(segmentAtStep(after.meterMap, after.currentStep, after.pickupSteps));
      }
      post(res.status, res.level);
    } catch (err) {
      post(matchError(err), 'error');
    } finally {
      useMatchBusy.setState({ busy: false });
    }
  };

  /* GROUPING field: a draft while typed, applied on Enter or when it loses focus. */
  const [groupDraft, setGroupDraft] = React.useState<string | null>(null);
  // Another segment, or an edit from elsewhere (UNIT, the GROUPS keys, undo), drops a draft that no longer describes it.
  React.useEffect(() => setGroupDraft(null), [selected, meter]);
  const commitGrouping = (): void => {
    if (groupDraft === null) return;
    const edit = setGroupingText(usePianoRollStore.getState().meterMap, selected, groupDraft);
    if (!edit) {
      post(`"${groupDraft}" IS NOT A GROUPING. TYPE WHOLE NUMBERS JOINED BY +, SUCH AS 3+3+2, UP TO ${BEATS_MAX} BEATS.`, 'warn');
      return;
    }
    setGroupDraft(null);
    writeMap(edit);
  };

  const onPickup = (dir: -1 | 1, fine: boolean): void => {
    const r = usePianoRollStore.getState();
    r.applyMeter({ pickupSteps: stepPickup(r.meterMap, r.pickupSteps, dir, fine) });
  };
  const pickupTop = pickupMax(segs);
  const firstUnit = segs[0].meter.den;

  const groups = groupChoices(meter);
  const groupsNow = groupsValue(meter.groups);
  const loopValue = lane.id === 0 || lane.cycleSteps == null ? 'All' : String(lane.cycleSteps);
  const barLen = Math.round(laneBar ?? stepsPerBar(meter));
  const spanOn = spanIsSegment(segs, selected, lane.span, pickupSteps);
  const spanNow = lane.span ? laneSpanLabel(segs, lane.span, pickupSteps) : null;
  const selSpan = segmentSpan(segs, selected, pickupSteps);
  const selWhole = selSpan.start <= 1e-9 && selSpan.end === null;
  // The TEMPO readout: the tempos the map moves between, with fermatas counted apart.
  const tempoSum = tempoSummary(tempoMap, rollBpm);

  return (
    <>
      <div className={FIELD}>
        <StripKey
          mini
          iconOnly
          aria-label="Previous meter change"
          aria-describedby="mf-bars-value"
          description="Select the meter change before this one"
          disabled={selected === 0}
          passFocusOnDisable
          onClick={() => setSel(selected - 1)}
          icon={<ChevronLeft className={MINI_GLYPH} />}
          legend="Previous meter change"
        />
        <span className={FIELD_LEGEND} title="Bars of the selected meter change; 7+ runs from bar 7 to the end">Bars</span>
        <span id="mf-bars-value" aria-live="polite" title="Bars of the selected meter change" className={`${FIELD_VALUE} min-w-6`}>
          {segmentLabel(segs, selected, totalSteps, pickupSteps)}
        </span>
        <StripKey
          mini
          iconOnly
          aria-label="Next meter change"
          aria-describedby="mf-bars-value"
          description="Select the meter change after this one"
          disabled={selected >= segs.length - 1}
          passFocusOnDisable
          onClick={() => setSel(selected + 1)}
          icon={<ChevronRight className={MINI_GLYPH} />}
          legend="Next meter change"
        />
      </div>

      <Stepper
        id="mf-beats"
        legend="Beats"
        title="Beats in a bar of the selected change (1-32). A new count clears the groups; 6/8, 9/8 and 12/8 start in threes."
        value={String(meter.num)}
        downLabel="Fewer beats"
        upLabel="More beats"
        downDisabled={meter.num <= BEATS_MIN}
        upDisabled={meter.num >= BEATS_MAX}
        onStep={(dir) => writeMap(setBeats(segs, selected, meter.num + dir))}
      />

      <div role="group" aria-label="Unit" className="shrink-0 inline-flex gap-px">
        {UNITS.map((d) => (
          <StripKey
            key={d}
            aria-pressed={meter.den === d}
            aria-label={`/${d}: ${UNIT_NAMES[d]}`}
            description={`Unit: ${UNIT_NAMES[d].toLowerCase()}s`}
            on={meter.den === d}
            onClick={() => writeMap(setUnit(segs, selected, d))}
            legend={`/${d}`}
          />
        ))}
      </div>

      {groups.length <= GROUP_KEYS_MAX ? (
        <div className={FIELD} title="Groups: how the beats of a bar gather under accents">
          <span id="mf-groups-legend" className={FIELD_LEGEND}>Groups</span>
          <div role="group" aria-labelledby="mf-groups-legend" className="inline-flex gap-px">
            {groups.map((g) => {
              const on = groupsNow === g.value;
              return (
                <button
                  key={g.value}
                  type="button"
                  aria-pressed={on}
                  title={g.value ? `Groups ${g.label}: an accent starts each group` : 'Even: the beats carry no grouping'}
                  className={`${MINI_KEY} ${keyTone({ on })}`}
                  onClick={() => writeMap(setGroups(segs, selected, parseGroupsValue(g.value)))}
                >
                  <span>{g.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={FIELD} title="Groups: how the beats of a bar gather under accents">
          <label htmlFor="mf-groups" className={FIELD_LEGEND}>Groups</label>
          <select
            id="mf-groups"
            name="mf-groups"
            value={groupsNow}
            onChange={(e) => writeMap(setGroups(segs, selected, parseGroupsValue(e.target.value)))}
            className={`${FIELD_SELECT} max-w-20`}
          >
            {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </div>
      )}
      <div className={FIELD} title="Grouping: type any grouping, such as 3+3+2+1, and press Enter. A sum that differs from the beats sets the beats too.">
        <label htmlFor="mf-grouping" className={FIELD_LEGEND}>Grouping</label>
        <input
          id="mf-grouping"
          name="mf-grouping"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={groupDraft ?? groupsValue(meter.groups)}
          placeholder="Even"
          onChange={(e) => setGroupDraft(e.target.value)}
          onBlur={commitGrouping}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitGrouping();
            else if (e.key === 'Escape') setGroupDraft(null);
          }}
          className={`${FIELD_VALUE} w-16 text-left bg-transparent border-none outline-none`}
        />
      </div>

      <StripKey
        iconOnly
        onClick={onAdd}
        disabled={addPastEnd}
        aria-label="Add a meter change at the playhead"
        description={
          addPastEnd
            ? `Bar ${addBar + 1} starts after the roll ends. Lengthen the roll or move the playhead back, then add.`
            : `Start a change at bar ${addBar + 1} with ${meterLabel(meter)}, then edit it.`
        }
        icon={<DiamondPlus className={STRIP_GLYPH} />}
        legend="Add"
      />
      <StripKey
        iconOnly
        onClick={onRemove}
        disabled={seg.bar === 0}
        passFocusOnDisable
        aria-label={`Remove the meter change at bar ${seg.bar + 1}`}
        description={seg.bar === 0 ? 'Bar 1 always keeps a meter' : `Remove the meter change at bar ${seg.bar + 1}`}
        icon={<DiamondMinus className={STRIP_GLYPH} />}
        legend="Remove"
      />
      <MetricModulationKey idBase="mf-mod" bar={seg.bar} onStatus={onStatus} />

      <Stepper
        id="mf-pickup"
        legend="Pickup"
        title={`Pickup: the notes before bar 1, a 1/${firstUnit} at a time; Shift-click steps half a 16th. Off starts the roll on a downbeat.`}
        value={pickupLabel(pickupSteps)}
        valueClass="min-w-7"
        downLabel="Shorter pickup"
        upLabel="Longer pickup"
        downIcon={<ChevronsLeft className={MINI_GLYPH} />}
        upIcon={<ChevronsRight className={MINI_GLYPH} />}
        downDisabled={pickupSteps <= 0}
        upDisabled={pickupSteps >= pickupTop}
        onStep={onPickup}
      />

      <Sep />

      {lanes.length <= LANE_KEYS_MAX ? (
        <div role="group" aria-label="Lanes" className="shrink-0 inline-flex gap-px">
          {lanes.map((l) => (
            <StripKey
              key={l.id}
              aria-pressed={l.id === activeLane}
              aria-label={`Lane ${l.name}`}
              description={`Lane ${l.name}: ${l.cycleSteps ? `loops every ${l.cycleSteps} steps` : 'runs the whole roll'}${l.span ? ` in bars ${laneSpanLabel(segs, l.span, pickupSteps)}` : ''}${l.id !== 0 && (l.meterMap || l.tuplet) ? `, in ${laneTimeLabel(l)}` : ''}. New notes go into the pressed lane.`}
              on={l.id === activeLane}
              onClick={() => usePianoRollStore.getState().setActiveLane(l.id)}
              icon={<LaneSwatch form={forms.get(l.id) ?? 'solid'} />}
              legend={l.name}
              legendClassName="max-w-12 truncate"
            />
          ))}
        </div>
      ) : (
        <div className={FIELD} title="Lane: new notes go into the chosen lane; each lane after A loops on its own">
          <label htmlFor="mf-lane" className={FIELD_LEGEND}>Lane</label>
          <LaneSwatch form={forms.get(lane.id) ?? 'solid'} />
          <select
            id="mf-lane"
            name="mf-lane"
            value={lane.id}
            onChange={(e) => usePianoRollStore.getState().setActiveLane(Number(e.target.value))}
            className={`${FIELD_SELECT} max-w-16`}
          >
            {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}
      <StripKey
        iconOnly
        onClick={onAddLane}
        aria-label="Add lane"
        description={`Add a lane that loops one bar of ${meterLabel(segs[0].meter)}, and draw into it`}
        icon={<ListPlus className={STRIP_GLYPH} />}
        legend="Add lane"
      />
      <StripKey
        iconOnly
        onClick={onRemoveLane}
        disabled={activeLane === 0}
        passFocusOnDisable
        aria-label={`Remove lane ${lane.name}`}
        description={activeLane === 0 ? 'Lane A always stays' : `Remove lane ${lane.name}; its notes move to lane A`}
        icon={<ListX className={STRIP_GLYPH} />}
        legend="Remove lane"
      />
      <StripKey
        ref={timeKeyRef}
        iconOnly
        onClick={() => setTimeOpen((v) => !v)}
        disabled={activeLane === 0}
        passFocusOnDisable
        aria-haspopup="dialog"
        aria-expanded={timeOpen}
        aria-controls="mf-lane-time"
        aria-label={`Lane ${lane.name} time: ${laneTimeLabel(lane)}`}
        description={
          activeLane === 0
            ? "Lane A keeps the roll's meter. Add a lane to give it a meter or a tuplet ratio of its own."
            : `Lane ${lane.name}'s own meter and tuplet ratio (${laneTimeLabel(lane)}); the grid draws and snaps to its bars while it is the active lane`
        }
        on={timeOpen}
        icon={<Timer className={STRIP_GLYPH} />}
        legend="Time"
      />

      <Stepper
        id="mf-loop"
        legend="Loop"
        title={lane.id === 0 ? 'Lane A runs the whole roll' : `Lane ${lane.name} loops every ${loopValue === 'All' ? 'roll' : `${loopValue} steps`}. Shift-click steps a bar of ${barLen}.`}
        value={loopValue}
        valueClass="min-w-5"
        downLabel={`Shorter loop for lane ${lane.name}`}
        upLabel={`Longer loop for lane ${lane.name}`}
        downIcon={<ArrowLeftToLine className={MINI_GLYPH} />}
        upIcon={<ArrowRightToLine className={MINI_GLYPH} />}
        downDisabled={lane.id === 0 || lane.cycleSteps === 1}
        upDisabled={lane.id === 0 || lane.cycleSteps == null}
        onStep={onLoop}
      />
      {/* The legend shows the bars the lane plays in, so the span reads without a hover. */}
      <StripKey
        onClick={onSpan}
        disabled={lane.id === 0 || (selWhole && !lane.span)}
        passFocusOnDisable
        aria-pressed={spanOn}
        on={spanOn}
        aria-label={`Span: lane ${lane.name} only in bars ${segmentLabel(segs, selected, totalSteps, pickupSteps)}`}
        description={
          lane.id === 0
            ? 'Lane A always runs the whole roll'
            : spanOn
              ? `Lane ${lane.name} plays only in bars ${spanNow}. Press to play it over the whole roll again.`
              : selWhole && !lane.span
                ? 'The selected meter change covers the whole roll. Add a change to give the lane part of it.'
                : `${spanNow ? `Lane ${lane.name} plays in bars ${spanNow}. ` : ''}Press to play lane ${lane.name} only in bars ${segmentLabel(segs, selected, totalSteps, pickupSteps)}, its loop starting at the first of them.`
        }
        icon={<Scissors className={STRIP_GLYPH} />}
        legend={spanNow ? `Bars ${spanNow}` : 'Span'}
      />

      {hasTempoChanges(tempoMap) && (
        <div className={FIELD}>
          <span
            className={FIELD_LEGEND}
            title="The roll's tempo changes, which MATCH writes from the song's downbeats and the TEMPO lane edits. The roll plays, bounces, exports and saves them."
          >
            Tempo
          </span>
          <span
            id="mf-tempo-value"
            aria-live="polite"
            title={tempoSum.title}
            className={`${FIELD_VALUE} min-w-10`}
          >
            {tempoSum.value}
          </span>
          <StripKey
            mini
            iconOnly
            aria-label={tempoSum.clearLabel}
            aria-describedby="mf-tempo-value"
            description={tempoSum.clearDescription}
            onClick={() => usePianoRollStore.getState().setTempoMap([])}
            icon={<Eraser className={MINI_GLYPH} />}
            legend={tempoSum.clearLabel}
          />
        </div>
      )}

      <Sep />

      {/* The ranges take the row's spare width up to the field's cap; GEN's
          auto margin takes what is left, so GEN and MATCH stay at the end. A
          short row narrows each range to 32px and no further. */}
      {([
        { k: 'sync', legend: 'Sync', value: sync, title: 'Syncopation amount: moves strong-beat notes onto the anticipations' },
        { k: 'accent', legend: 'Accent', value: accent, title: 'Accent amount: lifts the notes that start a group' },
      ] as const).map(({ k, legend, value, title }) => (
        <div key={k} className={`${FIELD_GROW} max-w-72`} title={title}>
          <label htmlFor={`mf-${k}`} className={FIELD_LEGEND}>{legend}</label>
          <input
            id={`mf-${k}`}
            name={`mf-${k}`}
            type="range"
            min={0}
            max={100}
            value={Math.round(value * 100)}
            onChange={(e) => setAmount(k, (parseInt(e.target.value, 10) || 0) / 100)}
            className={RANGE_FILL}
          />
          <span className={`${FIELD_VALUE} w-5.5`}>{Math.round(value * 100)}</span>
        </div>
      ))}

      <StripKey
        ref={genKeyRef}
        iconOnly
        onClick={() => setGenOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={genOpen}
        aria-controls="mf-gen"
        aria-label="Gen: write notes into the active lane"
        description="Generate: write notes into the active lane with one of LOOM's rules"
        on={genOpen}
        icon={<Blocks className={STRIP_GLYPH} />}
        legend="Gen"
        className="ml-auto"
      />
      <StripKey
        iconOnly
        onClick={() => void onMatch()}
        disabled={!songEntryId}
        aria-busy={matchBusy}
        aria-label="Match the meter to the song"
        description={
          songEntryId
            ? "Match: take the meter map, pickup, tempo, tempo changes, swing and lanes from the song's rhythm analysis (analyzing it first when needed)"
            : "Choose a song from the song field's list to match its meter"
        }
        icon={<AudioWaveform className={`${STRIP_GLYPH} ${matchBusy ? 'animate-pulse' : ''}`} />}
        legend="Match"
      />

      <DockFlyout
        open={timeOpen && activeLane !== 0}
        anchorRef={timeKeyRef}
        onClose={() => setTimeOpen(false)}
        placement="above"
        align="start"
        ceilingSelector="[data-dock-ceiling]"
        floorSelector="[data-dock-floor]"
        id="mf-lane-time"
        role="dialog"
        aria-label={`Lane ${lane.name} time`}
        className={`w-96 max-w-[92vw] ${FLYOUT_CARD}`}
      >
        <div className="flex flex-col gap-1.5 px-1.5 pt-1 pb-1.5">
          <div className="flex items-center gap-2 pb-1 border-b border-white/8">
            <span className="text-[12px] font-display font-extrabold uppercase et-ink">Lane {lane.name} time</span>
            <span className="inline-flex items-center gap-1 text-[12px] font-semibold et-ink-2 tabular-nums">
              <LaneSwatch form={forms.get(lane.id) ?? 'solid'} />
              <span>{laneTimeLabel(lane)}</span>
              {laneBar !== null && <span className="et-ink-3">bar {laneBar} steps</span>}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <label htmlFor="mf-lane-meter" className={`${FLYOUT_LEGEND} w-12 shrink-0`}>Meter</label>
            <select
              id="mf-lane-meter"
              name="mf-lane-meter"
              value={laneMeterValue(lane)}
              onChange={(e) => setLaneTime({ meterMap: laneMeterFromValue(e.target.value) })}
              className={`${FIELD_SELECT} max-w-36`}
            >
              {laneMeterChoices(lane).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <label htmlFor="mf-lane-meter-text" className={FLYOUT_LEGEND}>Typed</label>
            <input
              id="mf-lane-meter-text"
              name="mf-lane-meter-text"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={laneMeterDraft ?? laneMeterValue(lane)}
              placeholder="11/16 3+3+3+2"
              title="Type any meter, such as 11/16 or 11/16 3+3+3+2, and press Enter. Empty reads the roll's meter."
              onChange={(e) => setLaneMeterDraft(e.target.value)}
              onBlur={commitLaneMeter}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLaneMeter();
                else if (e.key === 'Escape') setLaneMeterDraft(null);
              }}
              className={`${FLYOUT_VALUE} w-28 text-left bg-transparent border-none outline-none`}
            />
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            <span id="mf-lane-ratio-legend" className={`${FLYOUT_LEGEND} w-12 shrink-0`}>Ratio</span>
            <div role="group" aria-labelledby="mf-lane-ratio-legend" className="flex flex-wrap gap-px">
              {[null, ...LANE_TUPLET_PRESETS].map((t) => {
                const on = t === null ? !laneRatio : !!laneRatio && laneRatio.n === t.n && laneRatio.m === t.m;
                return (
                  <button
                    key={tupletLabel(t)}
                    type="button"
                    aria-pressed={on}
                    title={t === null ? 'Straight: one lane beat to one roll beat' : `${t.n} lane beats in the time of ${t.m} roll beats`}
                    className={`${FLYOUT_KEY} ${keyTone({ on })}`}
                    onClick={() => setLaneTime({ tuplet: t })}
                  >
                    <span>{tupletLabel(t)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap pl-13">
            <Stepper
              flyout
              id="mf-lane-ratio-n"
              legend="Notes"
              title={`Lane beats in the ratio (1-${TUPLET_RATIO_MAX})`}
              value={String(ratioNow.n)}
              downLabel="Fewer lane beats"
              upLabel="More lane beats"
              downDisabled={!canStepLaneTuplet(laneRatio, 'n', -1)}
              upDisabled={!canStepLaneTuplet(laneRatio, 'n', 1)}
              onStep={(dir) => setLaneTime({ tuplet: stepLaneTuplet(laneRatio, 'n', dir) })}
            />
            <Stepper
              flyout
              id="mf-lane-ratio-m"
              legend="In"
              title={`Roll beats the lane's beats fill (1-${TUPLET_RATIO_MAX})`}
              value={String(ratioNow.m)}
              downLabel="Fewer roll beats"
              upLabel="More roll beats"
              downIcon={<ArrowLeftToLine className={MINI_GLYPH} />}
              upIcon={<ArrowRightToLine className={MINI_GLYPH} />}
              downDisabled={!canStepLaneTuplet(laneRatio, 'm', -1)}
              upDisabled={!canStepLaneTuplet(laneRatio, 'm', 1)}
              onStep={(dir) => setLaneTime({ tuplet: stepLaneTuplet(laneRatio, 'm', dir) })}
            />
          </div>

          <p className="text-[12px] font-semibold et-ink-2">
            Notes stay where they sound. While lane {lane.name} is the active lane the grid draws its bars in the accent, and a click, a drag,
            the arrow keys, TUPLET and APPLY land on its own beats and groups. A MIDI export keeps the lane's time.
          </p>
        </div>
      </DockFlyout>

      <DockFlyout
        open={genOpen}
        anchorRef={genKeyRef}
        onClose={() => setGenOpen(false)}
        placement="above"
        align="end"
        ceilingSelector="[data-dock-ceiling]"
        floorSelector="[data-dock-floor]"
        id="mf-gen"
        role="dialog"
        aria-label="Gen: write notes with a LOOM rule"
        className={`w-120 max-w-[92vw] ${FLYOUT_CARD}`}
      >
        {/* Tight vertical spacing: at a default-height dock the card fits between
            the ruler / Voice header line and 4px above the row without scrolling. */}
        <div className="flex flex-col gap-1 px-1.5 pt-1 pb-1">
          <div className="flex items-center gap-2 pb-1 border-b border-white/8">
            <span className="text-[12px] font-display font-extrabold uppercase et-ink">Gen</span>
            <span className="inline-flex items-center gap-1 text-[12px] font-semibold et-ink-2 tabular-nums" title={targetTitle}>
              <LaneSwatch form={forms.get(target.lane) ?? 'solid'} />
              <span>{target.name}</span>
              <span className="et-ink-3">{targetRange}</span>
            </span>
          </div>

          <div className="flex items-start gap-1">
            <span id="mf-gen-rule-legend" className={`${FLYOUT_LEGEND} w-12 shrink-0 pt-1.5`}>Rule</span>
            <div role="group" aria-labelledby="mf-gen-rule-legend" className="flex flex-wrap gap-px">
              {GEN_RULES.map((r) => (
                <button
                  key={r.kind}
                  type="button"
                  aria-pressed={gen.kind === r.kind}
                  title={`${r.legend}: ${r.title}`}
                  className={`${FLYOUT_KEY} ${keyTone({ on: gen.kind === r.kind })}`}
                  onClick={() => setGen({ kind: r.kind })}
                >
                  <span>{r.legend}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-wrap pl-13">
            {genOptionSpecs(gen.kind).map((spec) => {
              const value = spec.key === 'steps' ? ruleSteps : Number(opts[spec.key] ?? 0);
              return (
                <Stepper
                  key={spec.key}
                  flyout
                  id={`mf-gen-${spec.key}`}
                  legend={spec.legend}
                  title={spec.title}
                  value={formatOption(value, spec)}
                  downLabel={`Less ${spec.legend.toLowerCase()}`}
                  upLabel={`More ${spec.legend.toLowerCase()}`}
                  downDisabled={value <= spec.min}
                  upDisabled={value >= spec.max}
                  onStep={(dir) => setOpt(spec.key, stepOption(value, spec, dir))}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            <span id="mf-gen-gate-legend" className={`${FLYOUT_LEGEND} w-12 shrink-0`}>Gate</span>
            <div role="group" aria-labelledby="mf-gen-gate-legend" className="flex gap-px">
              {GATE_KEYS.map((g) => (
                <button
                  key={g.kind}
                  type="button"
                  aria-pressed={gen.gate === g.kind}
                  title={g.title}
                  className={`${FLYOUT_KEY} ${keyTone({ on: gen.gate === g.kind })}`}
                  onClick={() => setGen({ gate: g.kind })}
                >
                  <span>{g.legend}</span>
                </button>
              ))}
            </div>
            {gen.gate === 'chance' && (
              <Stepper
                flyout
                id="mf-gen-pct"
                title="Percent of steps the die lets through"
                value={`${gen.pct}%`}
                valueClass="min-w-7"
                downLabel="Lower chance"
                upLabel="Higher chance"
                downDisabled={gen.pct <= 0}
                upDisabled={gen.pct >= 100}
                onStep={(dir) => setGen({ pct: Math.max(0, Math.min(100, gen.pct + dir * 5)) })}
              />
            )}
            {gen.gate === 'lap' && (
              <>
                <Stepper
                  flyout
                  id="mf-gen-period"
                  legend="Period"
                  title="Passes in one period of the lap gate"
                  value={String(gen.period)}
                  downLabel="Shorter period"
                  upLabel="Longer period"
                  downDisabled={gen.period <= 1}
                  upDisabled={gen.period >= 8}
                  onStep={(dir) => {
                    const period = Math.max(1, Math.min(8, gen.period + dir));
                    const laps = gen.laps.filter((x) => x <= period);
                    setGen({ period, laps: laps.length ? laps : [1] });
                  }}
                />
                <span id="mf-gen-laps-legend" className={FLYOUT_LEGEND}>Laps</span>
                <div role="group" aria-labelledby="mf-gen-laps-legend" className="flex gap-px">
                  {Array.from({ length: gen.period }, (_, i) => i + 1).map((n) => {
                    const on = gen.laps.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={on}
                        aria-label={`Lap ${n}`}
                        title={`Pass ${n} of every ${gen.period} ${on ? 'plays' : 'rests'}`}
                        className={`${FLYOUT_KEY} ${keyTone({ on })}`}
                        onClick={() => setGen({ laps: on ? gen.laps.filter((x) => x !== n) : [...gen.laps, n].sort((a, b) => a - b) })}
                      >
                        <span>{n}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className={FIELD} title="Seed: the same seed writes the same notes">
              <label htmlFor="mf-gen-seed" className={FLYOUT_LEGEND}>Seed</label>
              <input
                id="mf-gen-seed"
                name="mf-gen-seed"
                type="number"
                min={0}
                max={999999}
                value={gen.seed}
                onChange={(e) => setGen({ seed: Math.max(0, Math.min(999999, parseInt(e.target.value, 10) || 0)) })}
                className="w-16 h-4 bg-transparent border-none outline-none text-[12px] font-bold et-ink tabular-nums"
              />
              <button
                type="button"
                className={`${MINI_ICON_KEY} ${KEY_REST}`}
                aria-label="New seed"
                title="Roll a new seed"
                onClick={() => setGen({ seed: Math.floor(Math.random() * 10000) })}
              >
                <Dices aria-hidden="true" className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className={`${FLYOUT_LEGEND} w-12 shrink-0`} aria-hidden="true">Pass</span>
            <div
              role="img"
              aria-label={`First pass: ${previewHits} of ${ruleSteps} steps play`}
              className="flex-1 min-w-0 h-4 flex items-end gap-px"
            >
              {preview.map((hit, i) => (
                <span key={i} className={`flex-1 min-w-px rounded-xs ${hit ? 'h-4 bg-[rgb(var(--et-accent))]' : 'h-2 bg-white/10'}`} />
              ))}
            </div>
            <span className={`${FLYOUT_VALUE} min-w-10`}>{previewHits}/{ruleSteps}</span>
          </div>

          <div className="flex items-center gap-2 pt-1 border-t border-white/8">
            <StripKey
              flyout
              onClick={onWrite}
              on
              aria-label={`Write the rule into lane ${target.name}`}
              description={`${targetTitle}, replacing the lane's notes there`}
              icon={<Send className="w-3 h-3" />}
              legend="Write"
            />
          </div>
        </div>
      </DockFlyout>
    </>
  );
};
