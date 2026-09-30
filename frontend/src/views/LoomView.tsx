/**
 * LoomView — the LOOM tab: a living colony of cells (docs/design/loom.md §10–11).
 *
 * Two views, chosen with the COLONY / LANES switch in the header and saved
 * with the tab's settings (loomStore `mode`). COLONY is the dish
 * (ColonyCanvas). LANES is the lane score (lib/loomScore): each lane on its
 * own grid, straight or a 1/12, 1/20, 1/24 or 1/28 tuplet grid, its length in
 * steps, and the score's `meter` directive, with the score's text in the CODE
 * pane.
 *
 * On the dish, cells are added with the toolbar's +
 * buttons or a right-click on the dish, wired by dragging from a cell's nub,
 * and edited in the CELL pane with buttons, chips and sliders — no typing.
 * The notation stays available: the CODE pane is the whole colony as text,
 * and the CELL pane can show one cell's line on request.
 *
 * The colony GROWS while it plays: `grow` in the header sets how eagerly it
 * buds, prunes and mutates on every bar (lib/colonyGrow.ts); BUD grows a
 * child off the selected cell now.
 *
 * Colours come from lib/loomPalette and the theme ink tokens; text is 12px+
 * bold sans (Orbitron on labels, keys and tabs) and primary ink so it reads on
 * every theme. The two score editors stay monospace: the notation lines up in
 * columns, one token per step.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Play, Dices } from 'lucide-react';
import { useLoomStore, type EdgeSel, type LoomMode } from '../state/loomStore';
import type { LaneCursor } from '../lib/loomEngine';
import { useShardIndexStore, type ShardRow } from '../state/shardIndexStore';
import { useLibraryStore } from '../state/libraryStore';
import { useLibrarySearch } from '../state/useLibrarySearch';
import { LOOM_TEMPLATES } from '../data/loomTemplates';
import { LANE_DIVS, LOOM_ROLES, TUPLET_DIVS, laneBarSteps, tupletGrids, type LockParam, type LoomLane, type LoomRole } from '../lib/loomScore';
import { beatClock } from '../lib/beatClock';
import * as shards from '../lib/shardEngine';
import { GEN_BLURB, GEN_GLYPH, GEN_KINDS, type GenKind } from '../lib/loomGen';
import { DEFAULT_SEED } from '../lib/loomEngine';
import { ColonyCanvas } from '../components/loom/ColonyCanvas';
import { findNode, GRAINS, graphAt, meterText, parseColony, partitions, serializeColony, SPACE_MODES, walkNodes, type ColonyNode, type GateNode, type LoopNode, type Meter, type ModNode, type RuleNode } from '../lib/colony';
import { cellColor, KIND_COLOR, ROLE_COLOR, rgba } from '../lib/loomPalette';
import { SurfacePlayKey } from '../components/ui/SurfacePlayKey';
import { CollapsibleRail } from '../components/ui/CollapsibleRail';

type Pane = 'cell' | 'code' | 'crate';

const label = 'text-xs font-display font-bold uppercase tracking-wider et-ink-2';
const input = 'compact-input rounded border border-white/25 bg-black/30 px-2 py-1 text-[13px] font-sans font-semibold et-ink focus:outline-none focus:border-amber-300';
const btn = 'rounded-md border border-white/25 px-2.5 py-1 text-xs font-display font-bold uppercase tracking-wider et-ink hover:bg-white/10 transition-colors disabled:opacity-40 disabled:pointer-events-none';
/** Bold sans label, field and button for the crate's library controls. */
const labelSans = 'text-xs font-bold uppercase tracking-wider et-ink-2';
const inputSans = 'compact-input rounded border border-white/25 bg-black/30 px-2 py-1 text-[13px] font-sans font-semibold et-ink focus:outline-none focus:border-amber-300';
const btnSans = 'rounded-md border border-white/25 px-2.5 py-1 text-xs font-sans font-bold uppercase tracking-wider et-ink hover:bg-white/10 transition-colors disabled:opacity-40 disabled:pointer-events-none';
const chip = 'rounded-md border px-2 py-1 text-xs font-sans font-bold et-ink transition-colors';

/**
 * An entry's title by id, over the whole library: `getById` answers from the
 * loaded pages or the single-entry cache and fetches an id it does not hold;
 * `lookupVersion` re-renders the caller when that fetch lands.
 */
function useEntryTitle(): (id: string) => string {
  const entries = useLibraryStore((s) => s.entries);
  const getById = useLibraryStore((s) => s.getById);
  // Bumped when a single-entry lookup lands: the one answer `getById` gives
  // that `entries` does not carry.
  const lookupVersion = useLibraryStore((s) => s.lookupVersion);
  return useMemo(() => {
    const loaded = new Map(entries.map((e) => [e.id, e.title]));
    return (id: string) => loaded.get(id) ?? getById(id)?.title ?? id.slice(0, 8);
  }, [entries, getById, lookupVersion]);
}

export function LoomView(): React.ReactElement {
  const running = useLoomStore((s) => s.running);
  const queued = useLoomStore((s) => s.queued);
  const bpm = useLoomStore((s) => s.bpm);
  const toggle = useLoomStore((s) => s.toggle);
  const setBpm = useLoomStore((s) => s.setBpm);
  const crate = useShardIndexStore((s) => s.crate);
  const status = useShardIndexStore((s) => s.status);
  const colony = useLoomStore((s) => s.colonyApplied);
  const colonyErrors = useLoomStore((s) => s.colonyErrors);
  const colonyDirty = useLoomStore((s) => s.colonyDirty);
  const colonyUnresolved = useLoomStore((s) => s.colonyUnresolved);
  const colonyLap = useLoomStore((s) => s.colonyLap);
  const colonyGen = useLoomStore((s) => s.colonyGen);
  const selected = useLoomStore((s) => s.colonySelected);
  const selectedEdge = useLoomStore((s) => s.colonySelectedEdge);
  const setGrow = useLoomStore((s) => s.setGrow);
  const setSwing = useLoomStore((s) => s.setSwing);
  const setGrain = useLoomStore((s) => s.setGrain);
  const growNow = useLoomStore((s) => s.growNow);
  const mode = useLoomStore((s) => s.mode);
  const setMode = useLoomStore((s) => s.setMode);
  const plane = useLoomStore((s) => s.applied);
  const planeErrors = useLoomStore((s) => s.errors);
  const planeDirty = useLoomStore((s) => s.dirty);
  const planeUnresolved = useLoomStore((s) => s.unresolved);
  const [pane, setPane] = useState<Pane>('cell');
  const lanesView = mode === 'plane';
  // The CELL pane edits the dish, so the lane score's rail holds CODE and CRATE.
  const panes: Pane[] = lanesView ? ['code', 'crate'] : ['cell', 'code', 'crate'];
  const shownPane: Pane = panes.includes(pane) ? pane : panes[0];

  const sharding = crate.filter((id) => status[id] === 'sharding' || status[id] === 'loading').length;
  const keyOf = (k?: string, scale?: string) => (k ? (k === 'follow' ? 'follow' : `${k}${scale === 'minor' ? 'm' : ''}`) : '—');
  const keyText = lanesView ? keyOf(plane.key, plane.scale) : keyOf(colony.key, colony.scale);
  const cells = useMemo(() => walkNodes(colony.root).length, [colony]);
  const rate = colony.grow?.rate ?? 0;
  const max = colony.grow?.max ?? 24;
  const swing = colony.swing ?? 0.5;
  const grain = colony.grain ?? 4;

  useEffect(() => () => { useLoomStore.getState().stop(); }, []);
  // A click on the dish opens the cell.
  useEffect(() => { if (selected || selectedEdge) setPane('cell'); }, [selected, selectedEdge]);

  return (
    <div className="absolute inset-0 flex flex-col bg-[#07050a] et-ink loom-surface">
      <header data-tour="loom-clock" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5 border-b border-white/15 bg-black/30 shrink-0">
        <ViewSwitch mode={mode} onChange={setMode} />
        <SurfacePlayKey size="bar" playing={running} onToggle={toggle} what={lanesView ? 'the lane score' : 'the colony'} />

        <div className="flex items-center gap-1.5">
          <label htmlFor="loom-bpm" className={label}>BPM</label>
          <button type="button" onClick={() => setBpm(Math.round(bpm) - 1)} className={btn} aria-label="BPM down">−</button>
          <input
            id="loom-bpm"
            name="loom-bpm"
            type="number"
            min={20}
            max={300}
            step={0.5}
            value={Math.round(bpm * 10) / 10}
            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setBpm(v); }}
            className={`${input} w-18 tabular-nums`}
          />
          <button type="button" onClick={() => setBpm(Math.round(bpm) + 1)} className={btn} aria-label="BPM up">+</button>
        </div>

        {!lanesView && (<>
        <div className="flex items-center gap-2">
          <label htmlFor="loom-grow-rate" className={label} title="How eagerly the colony buds, prunes and mutates on every bar. 0 = frozen.">grow</label>
          <input id="loom-grow-rate" name="loom-grow-rate" type="range" min={0} max={1} step={0.05} value={rate} onChange={(e) => setGrow({ rate: Number(e.target.value), max })} className="w-28 accent-emerald-300" aria-valuetext={rate === 0 ? 'frozen' : `${Math.round(rate * 100)}%`} />
          <span className="text-[13px] font-sans font-bold tabular-nums et-ink w-10">{rate === 0 ? 'off' : `${Math.round(rate * 100)}%`}</span>
          <span className={label}>max</span>
          <button type="button" onClick={() => setGrow({ rate, max: Math.max(2, max - 4) })} className={btn} aria-label="Fewer cells at most">−</button>
          <span className="text-[13px] font-sans font-bold tabular-nums et-ink w-6 text-center" aria-live="polite">{max}</span>
          <button type="button" onClick={() => setGrow({ rate, max: Math.min(96, max + 4) })} className={btn} aria-label="More cells at most">+</button>
          <button type="button" onClick={() => growNow()} className={`${btn} border-emerald-300/70`} title="One growth step now">✚ grow</button>
        </div>

        <div className="flex items-center gap-1.5" role="group" aria-label="Grain: beats per shard the colony reaches for">
          <span className={label} title="Beats per shard the colony reaches for when it buds. Bigger = longer, dronier.">grain</span>
          {GRAINS.map((g) => (
            <button key={g} type="button" aria-pressed={grain === g} onClick={() => setGrain(g)} className={`${chip} ${grain === g ? 'bg-white/15 border-white/70' : 'border-white/25 hover:bg-white/8'}`} title={g === 1 ? '1 beat: chopped' : g === 16 ? '16 beats: four-bar drones' : `${g} beats`}>{g}</button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="loom-swing" className={label} title="Odd steps of every rule land late. 50% is straight, 67% a triplet feel.">swing</label>
          <input id="loom-swing" name="loom-swing" type="range" min={0.5} max={0.75} step={0.01} value={swing} onChange={(e) => setSwing(Number(e.target.value))} className="w-24 accent-amber-300" aria-valuetext={`${Math.round(swing * 100)}%`} />
          <span className="text-[13px] font-sans font-bold tabular-nums et-ink w-9">{Math.round(swing * 100)}%</span>
        </div>

        <span className="text-[13px] font-sans et-ink tabular-nums" title="cells in the colony · root bar · growth steps">
          {cells} cells · {meterText(colony.root.meter)} · bar {colonyLap + 1} · gen {colonyGen}
        </span>
        </>)}
        {lanesView && (
          <span className="text-[13px] font-sans font-bold et-ink tabular-nums" title="lanes in the score · the bar the beat clock counts">
            {plane.lanes.length} lane{plane.lanes.length === 1 ? '' : 's'} · {plane.meter ? meterText(plane.meter) : "the clock's own meter"}
          </span>
        )}
        <span className="text-[13px] font-sans font-semibold et-ink-2"><span className={label}>key</span> {keyText}</span>
        <span className="text-[13px] font-sans font-semibold et-ink-2"><span className={label}>crate</span> {crate.length} song{crate.length === 1 ? '' : 's'}</span>
        <span className="text-xs font-sans font-bold text-amber-200" aria-live="polite">
          {sharding > 0 ? `sharding ${sharding} song${sharding === 1 ? '' : 's'}…` : ''}
          {queued ? ' · next bar' : ''}
          {lanesView
            ? (planeErrors.length > 0 ? ` · ${planeErrors.length} error${planeErrors.length === 1 ? '' : 's'} in the code` : planeDirty ? ' · code edited — apply to hear it' : '')
            : (colonyErrors.length > 0 ? ` · ${colonyErrors.length} error${colonyErrors.length === 1 ? '' : 's'} in the code` : colonyDirty ? ' · code edited — apply to hear it' : '')}
          {(lanesView ? planeUnresolved : colonyUnresolved).length > 0 ? ` · silent: ${(lanesView ? planeUnresolved : colonyUnresolved).slice(-2).join(', ')}` : ''}
        </span>
      </header>

      <div className="flex-1 min-h-0 flex">
        {lanesView ? (
          <section className="flex-1 min-w-0 overflow-auto" aria-label="The lane score">
            <LanesPane />
          </section>
        ) : (
          <section className="flex-1 min-w-0 relative" aria-label="The colony">
            <ColonyCanvas />
          </section>
        )}

        <CollapsibleRail
          as="aside"
          id="loom-rail"
          side="right"
          name={shownPane}
          label={lanesView ? 'the code and crate panes' : 'the cell, code and crate panes'}
          storageKey="loom.railCollapsed.v1"
          className="w-96 shrink-0 border-l border-white/15 bg-black/20 flex flex-col min-h-0"
        >
          {(foldKey) => (
            <>
              <div className="flex items-center border-b border-white/15">
                {/* At the rail's inner edge, beside the dish. */}
                <span className="flex pl-1.5">{foldKey}</span>
                <div role="tablist" aria-label="Loom panes" className="flex flex-1 min-w-0">
                  {panes.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      id={`loom-tab-${p}`}
                      aria-selected={shownPane === p}
                      aria-controls={`loom-pane-${p}`}
                      onClick={() => setPane(p)}
                      className={`flex-1 px-2 py-2 text-xs font-display font-bold uppercase tracking-wider transition-colors ${
                        shownPane === p ? 'et-ink border-b-2 border-amber-300' : 'et-ink-2 hover:et-ink'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div id={`loom-pane-${shownPane}`} role="tabpanel" aria-labelledby={`loom-tab-${shownPane}`} className="flex-1 min-h-0 overflow-auto">
                {shownPane === 'cell' && <CellPane />}
                {shownPane === 'code' && (lanesView ? <LaneCodePane /> : <ColonyCodePane />)}
                {shownPane === 'crate' && <CratePane />}
              </div>
            </>
          )}
        </CollapsibleRail>
      </div>
    </div>
  );
}

/* ── controls (mouse only) ─────────────────────────────────────────────── */

const Field: React.FC<{ id: string; label: string; children: React.ReactNode; hint?: string }> = ({ id, label: text, children, hint }) => (
  <div className="flex flex-col gap-1">
    <label htmlFor={id} className={label} title={hint}>{text}</label>
    {children}
  </div>
);

/** A row of buttons, one pressed. */
const Chips = <T extends string | number>({ id, label: text, value, options, onChange, color, hint }: { id: string; label: string; value: T; options: { v: T; t?: string; title?: string; color?: string }[]; onChange: (v: T) => void; color?: (v: T) => string | undefined; hint?: string }) => (
  <div className="flex flex-col gap-1">
    <span id={`${id}-label`} className={label} title={hint}>{text}</span>
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = o.v === value;
        const c = o.color ?? color?.(o.v);
        return (
          <button key={String(o.v)} type="button" aria-pressed={on} title={o.title} onClick={() => onChange(o.v)} className={`${chip} ${on ? 'bg-white/15' : 'hover:bg-white/8'}`} style={{ borderColor: c ? rgba(c, on ? 1 : 0.45) : on ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.25)', boxShadow: on && c ? `inset 0 0 0 1px ${rgba(c, 0.8)}` : undefined }}>
            {c && <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ background: c }} aria-hidden="true" />}
            {o.t ?? String(o.v)}
          </button>
        );
      })}
    </div>
  </div>
);

/** A slider with its number beside it. */
const Slider: React.FC<{ id: string; label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string; hint?: string; accent?: string }> = ({ id, label: text, value, min, max, step, onChange, fmt, hint, accent }) => (
  <div className="flex flex-col gap-0.5">
    <div className="flex items-center justify-between">
      <label htmlFor={id} className={label} title={hint}>{text}</label>
      <span className="text-[13px] font-sans font-bold tabular-nums et-ink">{fmt ? fmt(value) : String(Math.round(value * 100) / 100)}</span>
    </div>
    <input id={id} name={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" style={{ accentColor: accent }} aria-valuetext={fmt ? fmt(value) : undefined} />
  </div>
);

/** − value + */
const Stepper: React.FC<{ id: string; label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string; hint?: string }> = ({ id, label: text, value, min, max, step = 1, onChange, fmt, hint }) => (
  <div className="flex flex-col gap-1">
    <span id={`${id}-label`} className={label} title={hint}>{text}</span>
    <div role="group" aria-labelledby={`${id}-label`} className="flex items-center gap-1">
      <button type="button" onClick={() => onChange(Math.max(min, Math.round((value - step) * 1000) / 1000))} disabled={value <= min} className={btn} aria-label={`${text} down`}>−</button>
      <span className="text-[13px] font-sans font-bold tabular-nums et-ink min-w-10 text-center" aria-live="polite">{fmt ? fmt(value) : String(value)}</span>
      <button type="button" onClick={() => onChange(Math.min(max, Math.round((value + step) * 1000) / 1000))} disabled={value >= max} className={btn} aria-label={`${text} up`}>+</button>
    </div>
  </div>
);

const Toggle: React.FC<{ id: string; label: string; on: boolean; onChange: (v: boolean) => void; hint?: string }> = ({ id, label: text, on, onChange, hint }) => (
  <button id={id} type="button" aria-pressed={on} onClick={() => onChange(!on)} title={hint} className={`${chip} ${on ? 'bg-emerald-400/25 border-emerald-300' : 'border-white/25 hover:bg-white/8'}`}>
    {on ? '● ' : '○ '}{text}
  </button>
);

/* ── the view switch ───────────────────────────────────────────────────── */

/** COLONY or LANES: two keys with aria-pressed in a labelled group; the choice is saved (loomStore `mode`). */
const ViewSwitch: React.FC<{ mode: LoomMode; onChange: (m: LoomMode) => void }> = ({ mode, onChange }) => (
  <div role="group" aria-label="LOOM view" className="flex items-center rounded-md border border-white/25 overflow-hidden">
    {([
      { m: 'colony' as const, t: 'Colony', title: 'The dish: cells and wires that grow while they play' },
      { m: 'plane' as const, t: 'Lanes', title: 'The lane score: lanes on their own grids (1/12 to 1/28 tuplets) and the meter directive' },
    ]).map(({ m, t, title }) => (
      <button
        key={m}
        type="button"
        aria-pressed={mode === m}
        onClick={() => { if (mode !== m) onChange(m); }}
        title={title}
        className={`px-2.5 py-1 text-xs font-display font-bold uppercase tracking-wider transition-colors ${mode === m ? 'bg-white/15 et-ink' : 'et-ink-2 hover:bg-white/8'}`}
      >
        {t}
      </button>
    ))}
  </div>
);

/* ── LANES ───────────────────────────────────────────────────────────────── */

const STRAIGHT_NAMES: Record<number, string> = { 1: 'wholes', 2: 'halves', 4: 'quarters', 8: '8ths', 16: '16ths', 32: '32nds', 64: '64ths' };

/** A lane grid as its option reads: "1/16 · 16ths", "1/20 · 16th quintuplets". */
const divLabel = (div: number): string =>
  `1/${div} · ${TUPLET_DIVS.find((g) => g.div === div)?.name ?? STRAIGHT_NAMES[div] ?? 'steps'}`;

/** The lane score: its meter directive and every lane's grid, length and switches. */
const LanesPane: React.FC = () => {
  const score = useLoomStore((s) => s.applied);
  const cursors = useLoomStore((s) => s.cursors);
  const addLane = useLoomStore((s) => s.addLane);
  const setMeter = useLoomStore((s) => s.setMeter);
  return (
    <div className="flex flex-col gap-4 p-4 text-[13px] font-sans et-ink max-w-5xl">
      <div className="flex flex-col gap-2 max-w-xl">
        <span className="font-display font-bold text-sm uppercase tracking-wider">Meter</span>
        <p className="text-xs et-ink-2 leading-snug">
          The bar the beat clock counts while the score plays (the score&apos;s <b className="et-ink">meter</b> line). Each lane&apos;s grid reads against it.
        </p>
        {score.meter ? (
          <>
            <MeterEditor id="loom-plane-meter" meter={score.meter} tempo={1} onChange={(m) => setMeter(m)} isRoot />
            <button type="button" onClick={() => setMeter(null)} className={`${btn} self-start`} title="Remove the meter line: the clock keeps its own bar">clock meter</button>
          </>
        ) : (
          <>
            <p className="text-xs et-ink-2">No meter line: the beat clock keeps its own bar.</p>
            <button type="button" onClick={() => setMeter({ num: 4, den: 4, groups: [] })} className={`${btn} self-start`}>set a meter</button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="font-display font-bold text-sm uppercase tracking-wider">Lanes</span>
        <button type="button" onClick={addLane} className={btn}>+ lane</button>
      </div>
      <ul className="flex flex-col gap-2">
        {score.lanes.length === 0 && <li className="et-ink-2">No lanes. Add one, or load a sample in the CODE pane.</li>}
        {score.lanes.map((l) => <LaneRow key={l.name} lane={l} meter={score.meter} cursor={cursors[l.name]} />)}
      </ul>
    </div>
  );
};

const LaneRow: React.FC<{ lane: LoomLane; meter: Meter | undefined; cursor: LaneCursor | undefined }> = ({ lane, meter, cursor }) => {
  const setLaneOpts = useLoomStore((s) => s.setLaneOpts);
  const removeLane = useLoomStore((s) => s.removeLane);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const id = `loom-lane-${lane.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const rail = lane.rows[lane.rows.length - 1] ?? [];
  const filled = rail.filter(Boolean).length;
  const barSteps = laneBarSteps(lane, meter);
  const commitName = () => {
    const next = (nameDraft ?? '').trim();
    setNameDraft(null);
    if (next && next !== lane.name) setLaneOpts(lane.name, { name: next });
  };
  const barText = meter
    ? barSteps !== null
      ? `A ${meterText(meter)} bar holds ${barSteps} steps of 1/${lane.div}; ${lane.length} steps are ${Math.round((lane.length / barSteps) * 100) / 100} bars.`
      : `A ${meterText(meter)} bar holds ${Math.round(((lane.div * meter.num) / meter.den) * 100) / 100} steps of 1/${lane.div}, not a whole number, so the lane's steps cross its bar lines.`
    : `${lane.length} steps of 1/${lane.div}: ${Math.round((lane.length / lane.div) * 100) / 100} whole notes.`;
  return (
    <li className="rounded-md border border-white/15 p-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field id={`${id}-name`} label="lane" hint="Letters, digits, - _ and . (jumps to it follow a rename)">
          <input
            id={`${id}-name`}
            name={`${id}-name`}
            value={nameDraft ?? lane.name}
            spellCheck={false}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitName(); }
              if (e.key === 'Escape') setNameDraft(null);
            }}
            className={`${input} w-32`}
          />
        </Field>
        <Field id={`${id}-grid`} label="grid" hint="Steps per whole note. 1/12, 1/20, 1/24 and 1/28 are tuplet grids.">
          <select
            id={`${id}-grid`}
            name={`${id}-grid`}
            value={lane.div}
            onChange={(e) => setLaneOpts(lane.name, { div: Number(e.target.value) })}
            className={`${input} form-select`}
            style={{ colorScheme: 'dark' }}
          >
            {LANE_DIVS.map((d) => <option key={d} value={d}>{divLabel(d)}</option>)}
          </select>
        </Field>
        <Stepper id={`${id}-len`} label="steps" value={lane.length} min={1} max={256} onChange={(v) => setLaneOpts(lane.name, { length: v })} hint="The lane's length; it loops at its own length (polyrhythm)" />
        <Toggle id={`${id}-play`} label="plays" on={lane.play} onChange={(v) => setLaneOpts(lane.name, { play: v })} hint="A lane that does not play still steps (its gates and jumps still count)" />
        <Toggle id={`${id}-target`} label="jump target" on={lane.isTarget} onChange={(v) => setLaneOpts(lane.name, { isTarget: v })} hint="A target lane plays only when a jump sends to it, and is never the master" />
        <button type="button" onClick={() => removeLane(lane.name)} className={`${btn} ml-auto text-rose-300 border-rose-400/50`} aria-label={`Remove lane ${lane.name}`}>remove</button>
      </div>
      <p className="text-xs et-ink-2">{barText} {filled} of {lane.length} rail steps hold a tile.</p>
      <div aria-hidden="true" className="flex flex-wrap gap-0.5">
        {rail.map((t, i) => (
          <span key={i} className={`h-3 w-3 rounded-xs ${t ? 'bg-amber-300/80' : 'bg-white/10'} ${cursor?.step === i ? 'ring-1 ring-white' : ''}`} />
        ))}
      </div>
    </li>
  );
};

/** The lane score as text: the source of truth the LANES view writes. */
const LaneCodePane: React.FC = () => {
  const text = useLoomStore((s) => s.text);
  const errors = useLoomStore((s) => s.errors);
  const dirty = useLoomStore((s) => s.dirty);
  const running = useLoomStore((s) => s.running);
  const setText = useLoomStore((s) => s.setText);
  const apply = useLoomStore((s) => s.apply);
  const reset = useLoomStore((s) => s.resetStarter);
  const loadTemplate = useLoomStore((s) => s.loadTemplate);
  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-white/10">
        <label htmlFor="loom-lane-template" className={label}>sample</label>
        <select id="loom-lane-template" name="loom-lane-template" value="" onChange={(e) => { if (e.target.value) loadTemplate(e.target.value); }} className={`${input} form-select max-w-44`} style={{ colorScheme: 'dark' }}>
          <option value="">— load a lane score —</option>
          {LOOM_TEMPLATES.filter((t) => t.mode !== 'colony').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <div className="ml-auto flex gap-1">
          <button type="button" onClick={reset} className={btn}>starter</button>
          <button type="button" onClick={() => apply()} disabled={!dirty || errors.length > 0} className={`${btn} border-amber-300/70`}>Apply ⏎</button>
        </div>
      </div>
      <div className="px-3 py-1 text-xs font-sans font-semibold et-ink-2 leading-snug">
        {dirty ? 'edited' : 'applied'}{running && dirty ? ' · Apply queues to the next master wrap' : ''} · the LANES view writes here
      </div>
      <label htmlFor="loom-lane-code" className="sr-only">Lane score</label>
      <textarea
        id="loom-lane-code"
        name="loom-lane-code"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } }}
        className="flex-1 min-h-40 resize-none bg-transparent px-3 py-2 text-xs leading-5 font-mono et-ink focus:outline-none whitespace-pre overflow-auto"
        aria-describedby="loom-lane-errors"
      />
      <ul id="loom-lane-errors" className="max-h-28 overflow-auto border-t border-white/10 px-3 py-1.5 text-xs font-sans font-bold text-rose-300" aria-live="polite">
        {errors.length === 0 && <li className="et-ink-2 font-semibold">no errors · lane NAME 1/16 x16 [@target] · meter 7/8 2+2+3 · grids 1/12 1/20 1/24 1/28</li>}
        {errors.map((e, i) => <li key={i}>{e.line ? `line ${e.line}: ` : ''}{e.message}</li>)}
      </ul>
    </div>
  );
};

/* ── CELL ────────────────────────────────────────────────────────────────── */

const CellPane: React.FC = () => {
  const selected = useLoomStore((s) => s.colonySelected);
  const selectedEdge = useLoomStore((s) => s.colonySelectedEdge);
  const colony = useLoomStore((s) => s.colonyApplied);
  const found = selected ? findNode(colony.root, selected) : null;
  if (selectedEdge) return <EdgeInspector sel={selectedEdge} />;
  if (!found) return <RootInspector />;
  return <NodeInspector key={selected} nodeKey={selected!} node={found.node} path={found.path} graph={found.graph} />;
};

/** Nothing selected: the root dish's own settings. */
const RootInspector: React.FC = () => {
  const colony = useLoomStore((s) => s.colonyApplied);
  const setRootMeter = useLoomStore((s) => s.setRootMeter);
  const setSeed = useLoomStore((s) => s.setColonySeed);
  const reset = useLoomStore((s) => s.resetColonyStarter);
  const growNow = useLoomStore((s) => s.growNow);
  const cells = walkNodes(colony.root);
  return (
    <div className="flex flex-col gap-4 p-3 text-[13px] font-sans et-ink">
      <div>
        <div className="font-bold text-sm">the dish</div>
        <p className="et-ink-2 leading-snug mt-1">{cells.length} cells, {colony.root.edges.length} wires at the top. Click a cell or a wire to edit it. Add cells with the + buttons over the dish or a right-click on empty space.</p>
      </div>
      <MeterEditor id="loom-root" meter={colony.root.meter} tempo={colony.root.tempo} onChange={(m, t) => setRootMeter(m, t)} isRoot />
      <div className="flex flex-col gap-2 rounded-md border border-white/15 p-2">
        <Stepper id="loom-seed" label="seed (the dice)" value={colony.seed ?? DEFAULT_SEED} min={0} max={999999} onChange={setSeed} hint="Every roll — gates, rules, growth — hashes from this. Same seed, same colony." />
        <div className="flex gap-1">
          <button type="button" onClick={() => setSeed(Math.floor(Math.random() * 100000))} className={btn}>
            <Dices className="size-3" aria-hidden="true" /> new dice
          </button>
          <button type="button" onClick={() => growNow()} className={`${btn} border-emerald-300/70`}>✚ grow now</button>
          <button type="button" onClick={reset} className={`${btn} ml-auto`} title="Back to one pacemaker and one loop">reseed</button>
        </div>
      </div>
      <Legend />
    </div>
  );
};

const Legend: React.FC = () => (
  <div className="flex flex-col gap-1 text-xs font-sans et-ink-2 leading-snug">
    <span className={label}>what the shapes mean</span>
    <div><span style={{ color: KIND_COLOR.rule }}>●</span> <b className="et-ink">rule</b> — a pacemaker: fires symbols on its steps every bar</div>
    <div><span style={{ color: ROLE_COLOR.drums }}>●</span> <b className="et-ink">loop</b> — plays a stem when hit; its wires fire when it ends</div>
    <div><span style={{ color: KIND_COLOR.gate }}>◆</span> <b className="et-ink">gate</b> — lets a trigger through by chance or by lap</div>
    <div><span style={{ color: KIND_COLOR.mod }}>⬢</span> <b className="et-ink">mod</b> — colours what passes: cutoff, gain, pan, transpose</div>
    <div><span style={{ color: KIND_COLOR.colony }}>◌</span> <b className="et-ink">colony</b> — a whole dish as one cell, with its own meter</div>
  </div>
);

/** The most grouping chips the LOOM meter card shows. */
const LOOM_GROUPINGS_MAX = 9;

/** Meter + tempo, by buttons. */
const MeterEditor: React.FC<{ id: string; meter: Meter; tempo: number; onChange: (m: Meter, tempo: number) => void; isRoot?: boolean }> = ({ id, meter, tempo, onChange, isRoot }) => {
  // The card lists nine groupings at most, as it always has; the METER face lists more for the roll.
  const groupings = useMemo(() => partitions(meter.num, LOOM_GROUPINGS_MAX), [meter.num]);
  const groupsKey = meter.groups.join('+');
  return (
    <div className="flex flex-col gap-2 rounded-md border border-white/15 p-2">
      <div className="grid grid-cols-2 gap-2">
        <Stepper id={`${id}-num`} label="beats in a bar" value={meter.num} min={1} max={32} onChange={(v) => onChange({ num: v, den: meter.den, groups: [] }, tempo)} />
        <Chips id={`${id}-den`} label="beat unit" value={meter.den} options={[{ v: 4, t: '/4' }, { v: 8, t: '/8' }, { v: 16, t: '/16' }]} onChange={(v) => onChange({ ...meter, den: v }, tempo)} />
      </div>
      {groupings.length > 1 && (
        <Chips id={`${id}-groups`} label="grouping (accents)" value={groupsKey} options={groupings.map((g) => ({ v: g.join('+'), t: g.length ? g.join('+') : 'even' }))} onChange={(v) => onChange({ ...meter, groups: v ? v.split('+').map(Number) : [] }, tempo)} />
      )}
      {!isRoot && <Chips id={`${id}-tempo`} label="tempo (× the parent)" value={tempo} options={[0.25, 0.5, 1, 1.5, 2, 3].map((v) => ({ v, t: `×${v}` }))} onChange={(v) => onChange(meter, v)} />}
      <div className="text-xs et-ink-2">{meterText(meter)}{tempo !== 1 ? ` at ×${tempo}` : ''}</div>
    </div>
  );
};

const NodeInspector: React.FC<{ nodeKey: string; node: ColonyNode; path: string[]; graph: ReturnType<typeof graphAt> }> = ({ nodeKey, node, path, graph }) => {
  const update = useLoomStore((s) => s.updateColonyNode);
  const remove = useLoomStore((s) => s.removeColonyNode);
  const duplicate = useLoomStore((s) => s.duplicateColonyNode);
  const growNow = useLoomStore((s) => s.growNow);
  const setFocus = useLoomStore((s) => s.setColonyFocus);
  const removeEdge = useLoomStore((s) => s.removeColonyEdge);
  const selectEdge = useLoomStore((s) => s.selectColonyEdge);
  const select = useLoomStore((s) => s.selectColony);
  const [showNotation, setShowNotation] = useState(false);
  const set = (n: ColonyNode) => update(nodeKey, n);
  const parent = path.length ? path.join('/') : null;
  const color = cellColor(node.kind, node.kind === 'loop' ? node.query.role : undefined, false);
  const edgesIn = graph?.edges.filter((e) => e.to === node.id) ?? [];
  const edgesOut = graph?.edges.filter((e) => e.from === node.id) ?? [];
  const id = `loom-cell-${nodeKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <div className="flex flex-col gap-4 p-3 text-[13px] font-sans et-ink">
      <div className="flex items-start gap-2">
        <span className="mt-1 inline-block size-3 rounded-full shrink-0" style={{ background: color }} aria-hidden="true" />
        <div className="min-w-0">
          <div className="font-bold text-sm truncate">{node.id} <span className="font-normal et-ink-2">· {node.kind}</span></div>
          <div className="text-xs et-ink-2">{parent ? `inside ${parent}` : 'in the root dish'}</div>
        </div>
      </div>

      {node.kind === 'loop' && <LoopEditor id={id} node={node} set={set} />}
      {node.kind === 'rule' && <RuleEditor id={id} node={node} meter={graph?.meter ?? null} set={set} />}
      {node.kind === 'gate' && <GateEditor id={id} node={node} set={set} />}
      {node.kind === 'mod' && <ModEditor id={id} node={node} set={set} />}
      {node.kind === 'colony' && (
        <div className="flex flex-col gap-2">
          <p className="et-ink-2 leading-snug text-xs">{node.graph.nodes.length} cells, {node.graph.edges.length} wires inside. A trigger into it starts one bar of it; nothing pointing at it lets it run free.</p>
          <MeterEditor id={id} meter={node.graph.meter} tempo={node.graph.tempo} onChange={(m, t) => set({ ...node, graph: { ...node.graph, meter: m, tempo: t } })} />
          <button type="button" onClick={() => setFocus(nodeKey)} className={`${btn} border-sky-300/70 self-start`}>↓ dive in</button>
        </div>
      )}

      {/* Wires */}
      <div className="flex flex-col gap-1.5 rounded-md border border-white/15 p-2">
        <span className={label}>wires</span>
        {edgesIn.length === 0 && edgesOut.length === 0 && <span className="text-xs et-ink-2">none — drag from a cell's nub onto this one, or from this one's nub onto another.</span>}
        {edgesIn.map((e) => (
          <div key={`in-${e.from}`} className="flex items-center gap-1.5 text-xs">
            <button type="button" onClick={() => selectEdge({ parent, from: e.from, to: e.to })} className="et-ink hover:underline truncate" title="edit this wire">{e.from} → <b>{node.id}</b>{e.on != null ? ` on ${e.on}` : ''}</button>
            <button type="button" onClick={() => select(parent ? `${parent}/${e.from}` : e.from)} className={`${btn} ml-auto py-0.5`} title={`go to ${e.from}`}>go</button>
            <button type="button" onClick={() => removeEdge(parent, e.from, e.to)} className={`${btn} py-0.5 text-rose-300`} aria-label={`Delete wire ${e.from} to ${e.to}`}>×</button>
          </div>
        ))}
        {edgesOut.map((e) => (
          <div key={`out-${e.to}`} className="flex items-center gap-1.5 text-xs">
            <button type="button" onClick={() => selectEdge({ parent, from: e.from, to: e.to })} className="et-ink hover:underline truncate" title="edit this wire"><b>{node.id}</b> → {e.to}{e.on != null ? ` on ${e.on}` : ''}{node.kind === 'loop' ? (e.to === node.id ? ' (repeat)' : ' (when it ends)') : ''}</button>
            <button type="button" onClick={() => select(parent ? `${parent}/${e.to}` : e.to)} className={`${btn} ml-auto py-0.5`} title={`go to ${e.to}`}>go</button>
            <button type="button" onClick={() => removeEdge(parent, e.from, e.to)} className={`${btn} py-0.5 text-rose-300`} aria-label={`Delete wire ${e.from} to ${e.to}`}>×</button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => growNow(nodeKey)} className={`${btn} border-emerald-300/70`} title="Grow a child off this cell now">✚ bud</button>
        <button type="button" onClick={() => duplicate(nodeKey)} className={btn}>duplicate</button>
        <button type="button" onClick={() => setShowNotation((v) => !v)} aria-pressed={showNotation} className={btn} title="Show this cell as a line of notation (typing allowed here)">notation</button>
        <button type="button" onClick={() => remove(nodeKey)} className={`${btn} ml-auto text-rose-300 border-rose-400/50`}>delete</button>
      </div>

      {showNotation && node.kind !== 'colony' && <NotationLine nodeKey={nodeKey} node={node} />}
    </div>
  );
};

/** The typed escape hatch: one cell's line, round-tripped through the parser. */
const NotationLine: React.FC<{ nodeKey: string; node: ColonyNode }> = ({ nodeKey, node }) => {
  const update = useLoomStore((s) => s.updateColonyNode);
  const line = nodeLine(node);
  const [draft, setDraft] = useState(line);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(line); setErr(null); }, [line]);
  const commit = () => {
    const { score, errors } = parseColony(draft);
    if (errors.length) { setErr(errors[0].message); return; }
    const parsed = score.root.nodes[0];
    if (!parsed || parsed.kind !== node.kind) { setErr(`expected a ${node.kind} line`); return; }
    setErr(null);
    update(nodeKey, parsed);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="loom-colony-line" className={label}>notation (Enter to apply)</label>
      <textarea id="loom-colony-line" name="loom-colony-line" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} className={`${input} h-16 resize-none whitespace-pre`} />
      {err && <p className="text-xs font-semibold text-rose-300" role="alert">{err}</p>}
    </div>
  );
};

function nodeLine(n: ColonyNode): string {
  const one = serializeColony({ root: { meter: { num: 4, den: 4, groups: [] }, tempo: 1, nodes: [n], edges: [] } });
  return one.split('\n').filter((l) => l && !l.startsWith('meter')).join('\n');
}

const LoopEditor: React.FC<{ id: string; node: LoopNode; set: (n: ColonyNode) => void }> = ({ id, node, set }) => {
  const crate = useShardIndexStore((s) => s.crate);
  const title = useEntryTitle();
  const setQuery = (q: Partial<LoopNode['query']>) => set({ ...node, query: { ...node.query, ...q } });
  const setBeats = (beats: number) => set({ ...node, beats, query: { ...node.query, beats: [1, 4, 8, 16].includes(beats) ? beats : undefined } });
  return (
    <div className="flex flex-col gap-3">
      <Chips id={`${id}-role`} label="stem" value={node.query.role ?? ''} options={[{ v: '' as LoomRole | '', t: 'any' }, ...LOOM_ROLES.map((r) => ({ v: r as LoomRole | '', color: ROLE_COLOR[r] }))]} onChange={(v) => setQuery({ role: (v || undefined) as LoomRole | undefined, shardId: undefined })} hint="Which stem of the song the loop plays. Missing stems get cut on first play." />
      <Field id={`${id}-song`} label="song" hint="A song from the crate, or any of them">
        <select id={`${id}-song`} name={`${id}-song`} value={node.query.entry ?? ''} onChange={(e) => setQuery({ entry: e.target.value || undefined, shardId: undefined })} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
          <option value="">any in the crate</option>
          {crate.map((eid) => <option key={eid} value={eid}>{title(eid)}</option>)}
          {node.query.entry && !crate.includes(node.query.entry) && <option value={node.query.entry}>{node.query.entry}</option>}
        </select>
      </Field>
      {node.query.shardId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="et-ink-2 truncate">pinned: {node.query.shardId}</span>
          <button type="button" onClick={() => setQuery({ shardId: undefined })} className={`${btn} ml-auto py-0.5`}>unpin</button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Chips id={`${id}-beats`} label="length (beats)" value={node.beats} options={[0.5, 1, 2, 4, 8, 16].map((v) => ({ v }))} onChange={setBeats} hint="How long it plays, and when its wires fire" />
        <Toggle id={`${id}-hold`} label="hold" on={node.hold} onChange={(v) => set({ ...node, hold: v })} hint="Keep sounding until the next trigger" />
      </div>
      <Slider id={`${id}-gain`} label="gain" value={node.gain} min={-24} max={12} step={1} onChange={(v) => set({ ...node, gain: v })} fmt={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
      <div className="grid grid-cols-2 gap-2">
        <Stepper id={`${id}-glide`} label="glide (portamento)" value={node.glide} min={-12} max={12} onChange={(v) => set({ ...node, glide: v })} fmt={(v) => (v === 0 ? 'none' : `${v > 0 ? '+' : ''}${v} st`)} hint="The pitch slides this far across the loop's length" />
        <Stepper id={`${id}-trans`} label="transpose" value={node.transpose} min={-24} max={24} onChange={(v) => set({ ...node, transpose: v })} fmt={(v) => `${v > 0 ? '+' : ''}${v} st`} />
        <div className="flex flex-col gap-1">
          <span className={label}>octave</span>
          <div className="flex gap-1">
            <button type="button" onClick={() => set({ ...node, transpose: Math.max(-24, node.transpose - 12) })} className={btn}>−12</button>
            <button type="button" onClick={() => set({ ...node, transpose: 0 })} className={btn}>0</button>
            <button type="button" onClick={() => set({ ...node, transpose: Math.min(24, node.transpose + 12) })} className={btn}>+12</button>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-white/15 p-2">
        <span className={label}>space</span>
        <Slider id={`${id}-pan`} label="pan" value={node.pan} min={-1} max={1} step={0.1} onChange={(v) => set({ ...node, pan: v })} fmt={(v) => (v === 0 ? 'centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`)} accent="#8ecae6" />
        <Chips id={`${id}-space`} label="motion" value={node.space} options={SPACE_MODES.map((v) => ({ v, title: v === 'fixed' ? 'stays where pan puts it' : v === 'orbit' ? 'sweeps left–right while it sounds' : v === 'pingpong' ? 'alternates sides on every hit' : 'lands somewhere new on every hit' }))} onChange={(v) => set({ ...node, space: v })} />
        <Slider id={`${id}-cut`} label="low-pass" value={node.cutoff} min={0} max={1} step={0.05} onChange={(v) => set({ ...node, cutoff: v })} fmt={(v) => (v >= 0.999 ? 'open' : `${Math.round(v * 100)}%`)} accent="#e879f9" />
        <Slider id={`${id}-res`} label="resonance" value={node.resonance} min={0.1} max={12} step={0.1} onChange={(v) => set({ ...node, resonance: v })} fmt={(v) => (Math.abs(v - 0.7) < 0.05 ? 'flat' : `Q ${v.toFixed(1)}`)} accent="#e879f9" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Slider id={`${id}-emin`} label="energy at least" value={node.query.energyMin ?? 0} min={0} max={1} step={0.05} onChange={(v) => setQuery({ energyMin: v > 0 ? v : undefined })} fmt={(v) => (v > 0 ? v.toFixed(2) : 'any')} />
        <Slider id={`${id}-emax`} label="energy at most" value={node.query.energyMax ?? 1} min={0} max={1} step={0.05} onChange={(v) => setQuery({ energyMax: v < 1 ? v : undefined })} fmt={(v) => (v < 1 ? v.toFixed(2) : 'any')} />
      </div>
    </div>
  );
};

const STEP_CHOICES = [3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 16, 24, 32];

const RuleEditor: React.FC<{ id: string; node: RuleNode; meter: Meter | null; set: (n: ColonyNode) => void }> = ({ id, node, meter, set }) => {
  const o = node.opts;
  const grids = meter ? tupletGrids(meter) : [];
  const gridNow = grids.find((g) => g.steps === node.steps)?.div ?? 0;
  const num = (k: string, d: number) => { const v = Number(o[k]); return Number.isFinite(v) ? v : d; };
  const setOpt = (k: string, v: number | string) => set({ ...node, opts: { ...node.opts, [k]: v } });
  return (
    <div className="flex flex-col gap-3">
      <Chips id={`${id}-gen`} label="rule" value={node.gen} options={GEN_KINDS.map((g) => ({ v: g, t: `${GEN_GLYPH[g]} ${g}`, title: GEN_BLURB[g] }))} onChange={(g: GenKind) => set({ ...node, gen: g, opts: { ...(g === node.gen ? node.opts : {}) } })} />
      <p className="text-xs et-ink-2 leading-snug">{GEN_BLURB[node.gen]}</p>
      <Chips id={`${id}-steps`} label="steps per bar" value={node.steps} options={STEP_CHOICES.includes(node.steps) ? STEP_CHOICES.map((v) => ({ v })) : [...STEP_CHOICES, node.steps].sort((a, b) => a - b).map((v) => ({ v }))} onChange={(v) => set({ ...node, steps: v })} />
      {meter && grids.length > 0 && (
        <Chips
          id={`${id}-grid`}
          label="tuplet grid"
          hint={`Sets the steps per bar to a tuplet grid of the ${meter.num}/${meter.den} bar`}
          value={gridNow}
          options={grids.map((g) => ({ v: g.div, t: `1/${g.div}`, title: `${g.name}: ${g.steps} steps in a ${meter.num}/${meter.den} bar` }))}
          onChange={(div) => {
            const g = grids.find((x) => x.div === div);
            if (g) set({ ...node, steps: g.steps });
          }}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Stepper id={`${id}-symbols`} label="symbols" value={node.symbols} min={1} max={8} onChange={(v) => set({ ...node, symbols: v })} hint="Distinct symbols the rule can emit; a wire's ON picks one" />
        {node.gen === 'euclid' && <Stepper id={`${id}-rotate`} label="rotate per bar" value={Math.round(num('rotate', 1))} min={-8} max={8} onChange={(v) => setOpt('rotate', v)} />}
        {node.gen === 'life' && <Stepper id={`${id}-rows`} label="rows" value={Math.round(num('rows', 3)) || 3} min={3} max={8} onChange={(v) => setOpt('rows', v)} />}
        {node.gen === 'fib' && <Stepper id={`${id}-drift`} label="drift per bar" value={Math.round(num('drift', 1))} min={0} max={4} onChange={(v) => setOpt('drift', v)} />}
        {node.gen === 'fractal' && <Stepper id={`${id}-depth`} label="depth" value={Math.round(num('depth', 4))} min={1} max={8} onChange={(v) => setOpt('depth', v)} />}
        {node.gen === 'echo' && <Stepper id={`${id}-every`} label="every" value={Math.round(num('every', 3))} min={1} max={8} onChange={(v) => setOpt('every', v)} />}
        {node.gen === 'echo' && <Stepper id={`${id}-depth`} label="repeats" value={Math.round(num('depth', 3))} min={0} max={8} onChange={(v) => setOpt('depth', v)} />}
      </div>
      {node.gen === 'euclid' && <Slider id={`${id}-hits`} label="hits" value={Math.min(node.steps, Math.round(num('hits', 5)))} min={1} max={node.steps} step={1} onChange={(v) => setOpt('hits', v)} />}
      {node.gen === 'life' && <Slider id={`${id}-density`} label="seed density" value={num('density', 0.35)} min={0.05} max={0.95} step={0.05} onChange={(v) => setOpt('density', v)} fmt={(v) => `${Math.round(v * 100)}%`} />}
      {node.gen === 'life' && <Chips id={`${id}-lrule`} label="life rule" value={String(o.rule ?? 'B3/S23')} options={[{ v: 'B3/S23', t: 'Life B3/S23' }, { v: 'B36/S23', t: 'HighLife' }, { v: 'B2/S', t: 'Seeds' }, { v: 'B3/S12345', t: 'Maze' }, { v: 'B3678/S34678', t: 'Day&Night' }]} onChange={(v) => setOpt('rule', v)} />}
      {node.gen === 'fractal' && <Chips id={`${id}-kind`} label="figure" value={String(o.kind ?? 'thue')} options={[{ v: 'thue', t: 'Thue–Morse' }, { v: 'cantor', t: 'Cantor dust' }, { v: 'dragon', t: 'dragon curve' }, { v: 'sierpinski', t: 'Sierpinski' }]} onChange={(v) => setOpt('kind', v)} />}
      {node.gen === 'rand' && <Slider id={`${id}-p`} label="chance a step plays" value={num('p', 0.75)} min={0.05} max={1} step={0.05} onChange={(v) => setOpt('p', v)} fmt={(v) => `${Math.round(v * 100)}%`} />}
      {node.gen === 'echo' && <Slider id={`${id}-decay`} label="decay per repeat" value={num('decay', 6)} min={0} max={18} step={1} onChange={(v) => setOpt('decay', v)} fmt={(v) => `−${v} dB`} />}
      {(node.gen === 'accel' || node.gen === 'gliss') && (
        <div className="grid grid-cols-2 gap-2">
          <Slider id={`${id}-from`} label="from" value={num('from', node.gen === 'accel' ? 1 : -12)} min={node.gen === 'accel' ? 0.25 : -24} max={node.gen === 'accel' ? 4 : 24} step={node.gen === 'accel' ? 0.25 : 1} onChange={(v) => setOpt('from', v)} />
          <Slider id={`${id}-to`} label="to" value={num('to', node.gen === 'accel' ? 2 : 12)} min={node.gen === 'accel' ? 0.25 : -24} max={node.gen === 'accel' ? 4 : 24} step={node.gen === 'accel' ? 0.25 : 1} onChange={(v) => setOpt('to', v)} />
        </div>
      )}
    </div>
  );
};

const GateEditor: React.FC<{ id: string; node: GateNode; set: (n: ColonyNode) => void }> = ({ id, node, set }) => {
  const isChance = node.pct != null;
  const period = node.period ?? 4;
  const laps = node.laps ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Chips id={`${id}-kind`} label="gate" value={isChance ? 'chance' : 'cycle'} options={[{ v: 'chance', t: '? chance' }, { v: 'cycle', t: '! by lap' }]} onChange={(v) => set(v === 'chance' ? { kind: 'gate', id: node.id, pct: 50 } : { kind: 'gate', id: node.id, period: 4, laps: [1, 3] })} />
      {isChance ? (
        <Slider id={`${id}-pct`} label="lets through" value={node.pct ?? 50} min={0} max={100} step={5} onChange={(v) => set({ kind: 'gate', id: node.id, pct: v })} fmt={(v) => `${v}%`} accent="#ffb703" />
      ) : (
        <>
          <Chips id={`${id}-period`} label="every N bars" value={period} options={[2, 3, 4, 6, 8].map((v) => ({ v }))} onChange={(v) => set({ kind: 'gate', id: node.id, period: v, laps: laps.filter((l) => l <= v) })} />
          <div className="flex flex-col gap-1">
            <span id={`${id}-laps-label`} className={label}>open on bar</span>
            <div role="group" aria-labelledby={`${id}-laps-label`} className="flex flex-wrap gap-1">
              {Array.from({ length: period }, (_, i) => i + 1).map((l) => (
                <button key={l} type="button" aria-pressed={laps.includes(l)} onClick={() => set({ kind: 'gate', id: node.id, period, laps: laps.includes(l) ? laps.filter((x) => x !== l) : [...laps, l].sort((a, b) => a - b) })} className={`${chip} ${laps.includes(l) ? 'bg-amber-400/25 border-amber-300' : 'border-white/25 hover:bg-white/8'}`}>{l}</button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const MOD_PARAMS: { p: LockParam; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { p: 'gain', label: 'gain', min: -24, max: 12, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v} dB` },
  { p: 'pan', label: 'pan', min: -1, max: 1, step: 0.1, fmt: (v) => (v === 0 ? 'centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'L' : 'R'}`) },
  { p: 'transpose', label: 'transpose', min: -24, max: 24, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v} st` },
  { p: 'cutoff', label: 'low-pass', min: 0, max: 1, step: 0.05, fmt: (v) => (v >= 0.999 ? 'open' : `${Math.round(v * 100)}%`) },
  { p: 'resonance', label: 'resonance', min: 0.1, max: 12, step: 0.1, fmt: (v) => `Q ${v.toFixed(1)}` },
  { p: 'gate', label: 'length', min: 0.05, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { p: 'attack', label: 'attack', min: 0, max: 0.5, step: 0.01, fmt: (v) => `${Math.round(v * 1000)} ms` },
  { p: 'release', label: 'release', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 1000)} ms` },
];

const ModEditor: React.FC<{ id: string; node: ModNode; set: (n: ColonyNode) => void }> = ({ id, node, set }) => {
  const setParam = (p: LockParam, v: number | undefined) => {
    const params = { ...node.params };
    if (v === undefined) delete params[p]; else params[p] = v;
    set({ ...node, params });
  };
  const rel = node.mode === 'rel';
  return (
    <div className="flex flex-col gap-3">
      <Chips id={`${id}-mode`} label="mode" value={node.mode} options={[{ v: 'abs', t: '= set', title: 'set the value' }, { v: 'rel', t: '+ add', title: 'add to what comes in' }]} onChange={(v) => set({ ...node, mode: v })} />
      <div className="flex flex-col gap-2">
        {MOD_PARAMS.map((m) => {
          const on = node.params[m.p] !== undefined;
          const def = rel ? 0 : m.p === 'cutoff' || m.p === 'gate' ? 1 : m.p === 'resonance' ? 0.7 : 0;
          return (
            <div key={m.p} className="flex items-center gap-2">
              <Toggle id={`${id}-${m.p}-on`} label={m.label} on={on} onChange={(v) => setParam(m.p, v ? def : undefined)} />
              {on && <div className="flex-1"><Slider id={`${id}-${m.p}`} label={rel ? 'add' : 'set to'} value={node.params[m.p] ?? def} min={rel && m.p !== 'gain' && m.p !== 'transpose' && m.p !== 'pan' ? -m.max : m.min} max={m.max} step={m.step} onChange={(v) => setParam(m.p, v)} fmt={m.fmt} accent="#e879f9" /></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const EdgeInspector: React.FC<{ sel: EdgeSel }> = ({ sel }) => {
  const colony = useLoomStore((s) => s.colonyApplied);
  const removeEdge = useLoomStore((s) => s.removeColonyEdge);
  const setOn = useLoomStore((s) => s.setColonyEdgeOn);
  const select = useLoomStore((s) => s.selectColony);
  const g = graphAt(colony.root, sel.parent);
  const e = g?.edges.find((x) => x.from === sel.from && x.to === sel.to);
  const from = g?.nodes.find((n) => n.id === sel.from);
  const to = g?.nodes.find((n) => n.id === sel.to);
  if (!g || !e || !from || !to) return <p className="p-3 text-[13px] font-sans font-semibold et-ink-2">That wire is gone.</p>;
  const key = (id: string) => (sel.parent ? `${sel.parent}/${id}` : id);
  return (
    <div className="flex flex-col gap-4 p-3 text-[13px] font-sans et-ink">
      <div>
        <div className="font-bold text-sm">wire</div>
        <div className="flex items-center gap-1.5 mt-1">
          <button type="button" onClick={() => select(key(from.id))} className={`${chip} border-white/40 hover:bg-white/10`} style={{ borderColor: rgba(cellColor(from.kind, from.kind === 'loop' ? from.query.role : undefined, false), 0.8) }}>{from.id}</button>
          <span className="et-ink-2">→</span>
          <button type="button" onClick={() => select(key(to.id))} className={`${chip} border-white/40 hover:bg-white/10`} style={{ borderColor: rgba(cellColor(to.kind, to.kind === 'loop' ? to.query.role : undefined, false), 0.8) }}>{to.id}</button>
        </div>
        <p className="text-xs et-ink-2 leading-snug mt-2">
          {from.kind === 'rule' ? `Fires on ${from.id}'s steps.` : from.kind === 'loop' ? (from.id === to.id ? `${from.id} repeats when it ends.` : `${to.id} starts when ${from.id} ends.`) : `Passes what reaches ${from.id}.`}
        </p>
      </div>
      {from.kind === 'rule' && (
        <Chips id="loom-edge-on" label="only on symbol" value={e.on ?? -1} options={[{ v: -1, t: 'any' }, ...Array.from({ length: Math.max(1, from.symbols) }, (_, i) => ({ v: i, t: String(i) }))]} onChange={(v) => setOn(sel.parent, sel.from, sel.to, v < 0 ? undefined : v)} hint={`${from.id} emits ${from.symbols} symbol${from.symbols === 1 ? '' : 's'}`} />
      )}
      <button type="button" onClick={() => removeEdge(sel.parent, sel.from, sel.to)} className={`${btn} self-start text-rose-300 border-rose-400/50`}>delete wire</button>
    </div>
  );
};

/* ── CODE ────────────────────────────────────────────────────────────────── */

const ColonyCodePane: React.FC = () => {
  const text = useLoomStore((s) => s.colonyText);
  const errors = useLoomStore((s) => s.colonyErrors);
  const dirty = useLoomStore((s) => s.colonyDirty);
  const running = useLoomStore((s) => s.running);
  const setText = useLoomStore((s) => s.setColonyText);
  const apply = useLoomStore((s) => s.applyColony);
  const reset = useLoomStore((s) => s.resetColonyStarter);
  const loadTemplate = useLoomStore((s) => s.loadTemplate);
  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-white/10">
        <label htmlFor="loom-colony-template" className={label}>sample</label>
        <select id="loom-colony-template" name="loom-colony-template" value="" onChange={(e) => { if (e.target.value) void loadTemplate(e.target.value); }} className={`${input} form-select max-w-44`} style={{ colorScheme: 'dark' }}>
          <option value="">— load a colony —</option>
          {LOOM_TEMPLATES.filter((t) => t.mode === 'colony').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <div className="ml-auto flex gap-1">
          <button type="button" onClick={reset} className={btn}>seed</button>
          <button type="button" onClick={() => apply()} disabled={!dirty || errors.length > 0} className={`${btn} border-amber-300/70`}>Apply ⏎</button>
        </div>
      </div>
      <div className="px-3 py-1 text-xs font-sans font-semibold et-ink-2 leading-snug">
        {dirty ? 'edited' : 'applied'}{running && dirty ? ' · Apply queues to the next bar' : ''} · the colony writes itself here as it grows
      </div>
      <label htmlFor="loom-colony-code" className="sr-only">Colony score</label>
      <textarea
        id="loom-colony-code"
        name="loom-colony-code"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } }}
        className="flex-1 min-h-40 resize-none bg-transparent px-3 py-2 text-xs leading-5 font-mono et-ink focus:outline-none whitespace-pre overflow-auto"
        aria-describedby="loom-colony-errors"
      />
      <ul id="loom-colony-errors" className="max-h-28 overflow-auto border-t border-white/10 px-3 py-1.5 text-xs font-sans font-bold text-rose-300" aria-live="polite">
        {errors.length === 0 && <li className="et-ink-2 font-normal">no errors · cells: loop / rule / gate / mod / colony · wires: a -&gt; b [on=N] · grow RATE max=N</li>}
        {errors.map((e, i) => <li key={i}>{e.line ? `line ${e.line}: ` : ''}{e.message}</li>)}
      </ul>
    </div>
  );
};

/* ── CRATE ───────────────────────────────────────────────────────────────── */

const CratePane: React.FC = () => {
  const title = useEntryTitle();
  const crate = useShardIndexStore((s) => s.crate);
  const status = useShardIndexStore((s) => s.status);
  const byEntry = useShardIndexStore((s) => s.byEntry);
  const addToCrate = useShardIndexStore((s) => s.addToCrate);
  const removeFromCrate = useShardIndexStore((s) => s.removeFromCrate);
  const selected = useLoomStore((s) => s.colonySelected);
  const colony = useLoomStore((s) => s.colonyApplied);
  const update = useLoomStore((s) => s.updateColonyNode);
  const [browse, setBrowse] = useState<string>('');
  const [role, setRole] = useState<string>('drums');
  const [find, setFind] = useState('');
  // The crate's own search, over the whole library, independent of whatever
  // the LIBRARY tab is showing.
  const songs = useLibrarySearch({ q: find, kind: 'audio', sort: 'title_asc' });
  const addable = songs.rows.filter((e) => !crate.includes(e.id));
  const browseId = browse || crate[0] || '';
  const rows: ShardRow[] = useMemo(() => {
    const all = byEntry[browseId] ?? [];
    const drums = new Set(['drums', 'kick', 'snare', 'hihat', 'cymbals', 'toms']);
    return all.filter((r) => (role === 'drums' ? drums.has(r.role) : r.role === role) && r.beats === 4).slice(0, 48);
  }, [byEntry, browseId, role]);
  const selLoop = selected ? findNode(colony.root, selected) : null;
  const canPin = selLoop?.node.kind === 'loop';

  const audition = (r: ShardRow) => {
    const when = beatClock.nextGrid('beat');
    shards.releaseLane('audition', when, 0.01);
    void shards.launch(r, { when, durationSec: (r.beats * 60) / beatClock.bpm, lane: 'audition', bpm: beatClock.bpm });
  };
  const pin = (r: ShardRow) => {
    if (!selLoop || selLoop.node.kind !== 'loop' || !selected) return;
    update(selected, { ...selLoop.node, query: { shardId: r.id } });
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-[13px] font-sans et-ink">
      <div className="flex flex-col gap-1">
        <label htmlFor="loom-crate-find" className={labelSans}>find a song in the library</label>
        <input
          id="loom-crate-find"
          name="loom-crate-find"
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="title, artist, bpm, key…"
          className={`${inputSans} w-full`}
        />
        <label htmlFor="loom-crate-add" className={labelSans}>add a song to the crate</label>
        <select
          id="loom-crate-add"
          name="loom-crate-add"
          value=""
          onChange={(e) => { if (e.target.value) addToCrate(e.target.value); }}
          className={`${inputSans} form-select w-full`}
          style={{ colorScheme: 'dark' }}
        >
          <option value="">
            {songs.loading && songs.rows.length === 0
              ? 'searching…'
              : `— choose (${songs.total.toLocaleString()} ${songs.total === 1 ? 'match' : 'matches'}) —`}
          </option>
          {addable.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
        {songs.error && (
          <p className="text-xs font-sans font-semibold et-ink-2">Could not search the library: {songs.error}</p>
        )}
        {songs.hasMore && (
          <button type="button" onClick={songs.loadMore} disabled={songs.loading} className={`${btnSans} self-start`}>
            {songs.loading ? 'loading…' : `more songs (${(songs.total - songs.rows.length).toLocaleString()} left)`}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {crate.length === 0 && <li className="et-ink-2">Empty crate: loops search the whole index.</li>}
        {crate.map((id) => {
          const st = status[id] ?? 'idle';
          const n = byEntry[id]?.length ?? 0;
          const key = byEntry[id]?.find((r) => r.key);
          return (
            <li key={id} className="flex items-center gap-2 rounded-md border border-white/15 px-2 py-1">
              <span className="truncate et-ink">{title(id)}</span>
              <span className="et-ink-2 shrink-0 text-xs">
                {st === 'sharding' ? 'sharding…' : st === 'loading' ? 'loading…' : st === 'error' ? 'error' : n ? `${n} shards` : 'no shards'}
                {key ? ` · ${key.key}${key.scale === 'minor' ? 'm' : ''} · ${Math.round(key.bpm)}` : ''}
              </span>
              <button type="button" onClick={() => removeFromCrate(id)} aria-label={`Remove ${title(id)} from the crate`} className="ml-auto et-ink-2 hover:text-rose-300 text-base leading-none">×</button>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-white/15 pt-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Field id="loom-browse-song" label="browse">
            <select id="loom-browse-song" name="loom-browse-song" value={browseId} onChange={(e) => setBrowse(e.target.value)} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
              {crate.map((id) => <option key={id} value={id}>{title(id)}</option>)}
            </select>
          </Field>
          <Field id="loom-browse-role" label="stem">
            <select id="loom-browse-role" name="loom-browse-role" value={role} onChange={(e) => setRole(e.target.value)} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
              {LOOM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <p className="text-xs et-ink-2">{canPin ? `pin a bar to ${selected}` : 'select a loop cell to pin a bar to it'}</p>
        <ul className="flex flex-col gap-0.5 max-h-72 overflow-auto">
          {rows.length === 0 && <li className="et-ink-2">no one-bar shards for this stem</li>}
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-white/8">
              <button type="button" onClick={() => audition(r)} aria-label={`Audition ${r.stem_name} bar ${r.bar_index}`} className="text-amber-300 hover:text-amber-200">
                <Play className="w-3 h-3 fill-current" />
              </button>
              <span className="et-ink tabular-nums">#{String(r.bar_index).padStart(3, '0')}</span>
              <span className="et-ink-2 text-xs">{r.stem_name}</span>
              <span className="et-ink-2 text-xs tabular-nums">e{r.energy.toFixed(2)}</span>
              {r.chord ? <span className="et-ink-2 text-xs">{r.chord}</span> : null}
              {r.words ? <span className="truncate et-ink-2 text-xs italic">{r.words}</span> : null}
              <button type="button" onClick={() => pin(r)} disabled={!canPin} className={`${btn} ml-auto py-0`} aria-label={`Pin ${r.stem_name} bar ${r.bar_index} to the selected loop`}>pin</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
