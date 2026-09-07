/**
 * LoomView — the LOOM tab: Jacquard's plane with shards for notes
 * (docs/design/loom.md §4–5).
 *
 * The plane is a grid of SAME-SIZE square tiles, like Jacquard's: every lane
 * is a band of rows over one shared step axis; the last row of a band is the
 * rail (where shards sit), the rows above are the upper stack, read top→bottom
 * at every step. Lane headers live in a fixed left column so the step columns
 * line up across lanes and the whole plane scrolls together. Click a tile to
 * select it, right-click to place one, edit it in the TILE pane.
 *
 * Colours come from the theme tokens (`et-ink*`, `bg-black/*`, `border-white/*`
 * are remapped per theme in index.css) so the plane reads on every theme; tile
 * hues are translucent fills under theme ink.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { useLoomStore, type TileSel } from '../state/loomStore';
import { useShardIndexStore, type ShardRow } from '../state/shardIndexStore';
import { useLibraryStore } from '../state/libraryStore';
import { LOOM_TEMPLATES } from '../data/loomTemplates';
import {
  LOCK_PARAMS,
  LIVE_LOCK_PARAMS,
  LOOM_ROLES,
  ROLE_LETTER,
  serializeTile,
  type LockParam,
  type LoomLane,
  type LoomRole,
  type LoomTile,
} from '../lib/loomScore';
import { beatClock } from '../lib/beatClock';
import * as shards from '../lib/shardEngine';

type Pane = 'code' | 'tile' | 'crate';

const DIVS = [1, 2, 4, 8, 16, 32, 64];

/** One tile = one square. Every lane, every row, every step. */
const CELL = 'size-11';
const label = 'text-[10px] font-mono uppercase tracking-widest et-ink-3';
const input = 'compact-input rounded border border-white/15 bg-black/30 px-1.5 py-0.5 text-[11px] font-mono et-ink focus:outline-none focus:border-amber-400/70';
const btn = 'rounded border border-white/15 px-2 py-1 text-[10px] font-mono uppercase tracking-wider et-ink-2 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:pointer-events-none';

const LETTER_FOR_ROLE: Record<string, string> = Object.fromEntries(Object.entries(ROLE_LETTER).map(([k, v]) => [v, k]));

export function LoomView(): React.ReactElement {
  const running = useLoomStore((s) => s.running);
  const queued = useLoomStore((s) => s.queued);
  const errors = useLoomStore((s) => s.errors);
  const dirty = useLoomStore((s) => s.dirty);
  const bpm = useLoomStore((s) => s.bpm);
  const applied = useLoomStore((s) => s.applied);
  const unresolved = useLoomStore((s) => s.unresolved);
  const toggle = useLoomStore((s) => s.toggle);
  const setBpm = useLoomStore((s) => s.setBpm);
  const addLane = useLoomStore((s) => s.addLane);
  const crate = useShardIndexStore((s) => s.crate);
  const status = useShardIndexStore((s) => s.status);
  const [pane, setPane] = useState<Pane>('code');

  const sharding = crate.filter((id) => status[id] === 'sharding' || status[id] === 'loading').length;
  const keyText = applied.key ? (applied.key === 'follow' ? 'follow' : `${applied.key}${applied.scale === 'minor' ? 'm' : ''}`) : '—';
  const maxSteps = Math.max(1, ...applied.lanes.map((l) => l.length));

  useEffect(() => () => { useLoomStore.getState().stop(); }, []);

  return (
    <div className="absolute inset-0 flex flex-col bg-[#07050a] et-ink loom-surface">
      <header className="flex items-center gap-3 px-3 py-1.5 border-b border-white/10 bg-black/30 shrink-0">
        <button
          type="button"
          onClick={toggle}
          aria-label={running ? 'Stop the loom' : 'Play the loom'}
          aria-pressed={running}
          className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors ${
            running ? 'border-amber-400/70 bg-amber-400/20 et-ink' : 'border-white/15 et-ink hover:bg-white/5'
          }`}
        >
          {running ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
          {running ? 'Stop' : 'Play'}
        </button>
        <div className="flex items-center gap-1.5">
          <label htmlFor="loom-bpm" className={label}>BPM</label>
          <input
            id="loom-bpm"
            name="loom-bpm"
            type="number"
            min={20}
            max={300}
            step={0.5}
            value={Math.round(bpm * 10) / 10}
            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setBpm(v); }}
            className={`${input} w-16 tabular-nums`}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className={label}>Key</span>
          <span className="text-[11px] font-mono et-ink-2">{keyText}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={label}>Crate</span>
          <span className="text-[11px] font-mono et-ink-2">{crate.length} song{crate.length === 1 ? '' : 's'}</span>
        </div>
        <span className="text-[10px] font-mono et-ink-3" aria-live="polite">
          {sharding > 0 ? `sharding ${sharding} song${sharding === 1 ? '' : 's'}…` : ''}
          {queued ? ' · new score waits for the master wrap' : ''}
          {errors.length > 0 ? ` · ${errors.length} error${errors.length === 1 ? '' : 's'} in the code` : dirty ? ' · code edited — apply to hear it' : ''}
          {unresolved.length > 0 ? ` · silent: ${unresolved.slice(-2).join(', ')}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={addLane} className={btn}>+ Lane</button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <section className="flex-1 min-w-0 overflow-auto p-3" aria-label="The plane">
          {applied.lanes.length === 0 && (
            <p className="text-[11px] font-mono et-ink-3">No lanes. Add one, load a template in CODE, or write a score.</p>
          )}
          <div className="flex flex-col gap-2" style={{ minWidth: `calc(14rem + ${maxSteps} * 2.75rem + ${Math.ceil(maxSteps / 4)} * 0.375rem)` }}>
            <StepRuler steps={maxSteps} />
            {applied.lanes.map((lane) => (
              <LaneBand key={lane.name} lane={lane} onOpenTile={() => setPane('tile')} />
            ))}
          </div>
        </section>

        <aside className="w-96 shrink-0 border-l border-white/10 bg-black/20 flex flex-col min-h-0">
          <div role="tablist" aria-label="Loom panes" className="flex border-b border-white/10">
            {(['code', 'tile', 'crate'] as Pane[]).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                id={`loom-tab-${p}`}
                aria-selected={pane === p}
                aria-controls={`loom-pane-${p}`}
                onClick={() => setPane(p)}
                className={`flex-1 px-2 py-1.5 text-[10px] font-mono uppercase tracking-widest transition-colors ${
                  pane === p ? 'et-ink border-b-2 border-amber-400/70' : 'et-ink-3 hover:et-ink-2'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <div id={`loom-pane-${pane}`} role="tabpanel" aria-labelledby={`loom-tab-${pane}`} className="flex-1 min-h-0 overflow-auto">
            {pane === 'code' && <CodePane />}
            {pane === 'tile' && <TilePane />}
            {pane === 'crate' && <CratePane />}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ── the plane ───────────────────────────────────────────────────────────── */

/** Step numbers along the top; a wider gap every four steps. */
const StepRuler: React.FC<{ steps: number }> = ({ steps }) => (
  <div className="flex items-end gap-1 pl-56" aria-hidden="true">
    {Array.from({ length: steps }, (_, i) => (
      <div key={i} className={`${CELL} flex items-end justify-center text-[9px] font-mono et-ink-3 tabular-nums ${i % 4 === 0 ? 'ml-1.5' : ''} ${i === 0 ? 'ml-0!' : ''}`}>
        {i % 4 === 0 ? i + 1 : ''}
      </div>
    ))}
  </div>
);

/** Tile fills: translucent hue under theme ink. Light themes (the Shell sets
 *  `data-et-light`) get denser fills and darker borders so a tile still reads
 *  as a tile against a pale canvas (the audit had them at 1.1:1). */
const TILE_FILL: Record<LoomTile['kind'], string> = {
  shard: 'bg-amber-400/25 border-amber-400/40 [[data-et-light]_&]:bg-amber-500/55 [[data-et-light]_&]:border-amber-800/70',
  chance: 'bg-emerald-400/20 border-emerald-400/40 [[data-et-light]_&]:bg-emerald-500/45 [[data-et-light]_&]:border-emerald-800/70',
  cycle: 'bg-teal-400/20 border-teal-400/40 [[data-et-light]_&]:bg-teal-500/45 [[data-et-light]_&]:border-teal-800/70',
  lock: 'bg-sky-400/20 border-sky-400/40 [[data-et-light]_&]:bg-sky-500/45 [[data-et-light]_&]:border-sky-800/70',
  jump: 'bg-fuchsia-400/20 border-fuchsia-400/40 [[data-et-light]_&]:bg-fuchsia-500/45 [[data-et-light]_&]:border-fuchsia-800/70',
};
const HELD_FILL = 'bg-amber-400/10 border-amber-400/20 [[data-et-light]_&]:bg-amber-500/45 [[data-et-light]_&]:border-amber-800/60';
const DANGER_TEXT = 'text-rose-400 [[data-et-light]_&]:text-rose-900';
const MASTER_TEXT = 'text-amber-300/90 [[data-et-light]_&]:text-amber-900';

/** The big glyph and the small line under it, per tile. */
function tileFace(t: LoomTile): { glyph: string; sub: string } {
  switch (t.kind) {
    case 'shard': {
      const q = t.query;
      const glyph = q.role ? LETTER_FOR_ROLE[q.role] ?? q.role[0] : q.shardId ? '#' : '∗';
      const sub = q.entry ? q.entry.slice(0, 7) : q.text ? `"${q.text.slice(0, 5)}"` : q.energyMin != null ? `e>${q.energyMin}` : q.bar != null ? `#${q.bar}` : '';
      return { glyph, sub: `${sub}${t.roll ? '^' : ''}` };
    }
    case 'chance': return { glyph: '?', sub: `${Math.round(t.pct)}%` };
    case 'cycle': return { glyph: '!', sub: `${t.laps.join(',')}:${t.period}` };
    case 'lock': return { glyph: t.mode === 'abs' ? '=' : '+', sub: Object.keys(t.params).slice(0, 2).map((k) => k.slice(0, 3)).join(' ') };
    case 'jump': return { glyph: '→', sub: t.target.slice(0, 6) };
  }
}

const LaneBand: React.FC<{ lane: LoomLane; onOpenTile: () => void }> = ({ lane, onOpenTile }) => {
  const cursors = useLoomStore((s) => s.cursors);
  const fired = useLoomStore((s) => s.fired[lane.name]);
  const selected = useLoomStore((s) => s.selected);
  const select = useLoomStore((s) => s.select);
  const setTile = useLoomStore((s) => s.setTile);
  const addRow = useLoomStore((s) => s.addRow);
  const removeRow = useLoomStore((s) => s.removeRow);
  const setLaneOpts = useLoomStore((s) => s.setLaneOpts);
  const removeLane = useLoomStore((s) => s.removeLane);
  const lanes = useLoomStore((s) => s.applied.lanes);
  const resolvedFor = useLoomStore((s) => s.resolvedFor);
  const menu = useContextMenu<TileSel>();

  // Live step in THIS lane: its own runner, or a runner that jumped here.
  const { liveStep, lap } = useMemo(() => {
    for (const [home, c] of Object.entries(cursors)) {
      if (c.laneName === lane.name && (home === lane.name || lane.isTarget)) return { liveStep: c.step, lap: c.lap };
    }
    return { liveStep: -1, lap: cursors[lane.name]?.lap ?? 0 };
  }, [cursors, lane.name, lane.isTarget]);

  const ids = `loom-${lane.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const isMaster = lanes.find((l) => !l.isTarget)?.name === lane.name;

  const menuItems = useCallback((sel: TileSel): ContextMenuItem[] => {
    const set = (tile: LoomTile | null) => () => { setTile(sel, tile); select(sel); onOpenTile(); };
    const shard = (role: LoomRole): LoomTile => ({ kind: 'shard', query: { role }, steps: 1, roll: 0 });
    const others = lanes.filter((l) => l.name !== lane.name);
    return [
      { type: 'header', label: 'Shard' },
      ...(['kick', 'snare', 'hihat', 'drums', 'bass', 'vocals', 'other', 'mix'] as LoomRole[]).map((r) => ({
        type: 'item' as const, label: r, hint: LETTER_FOR_ROLE[r], onSelect: set(shard(r)),
      })),
      { type: 'separator' },
      { type: 'item', label: 'Chance gate', hint: '?50', onSelect: set({ kind: 'chance', pct: 50 }) },
      { type: 'item', label: 'Cycle gate', hint: '!2:4', onSelect: set({ kind: 'cycle', period: 4, laps: [2] }) },
      { type: 'item', label: 'Lock', hint: '=gain-6', onSelect: set({ kind: 'lock', mode: 'abs', params: { gain: -6 } }) },
      { type: 'item', label: 'Jump', hint: others[0] ? `->${others[0].name}` : 'needs a lane', disabled: others.length === 0, onSelect: set({ kind: 'jump', target: others[0]?.name ?? '' }) },
      { type: 'separator' },
      { type: 'item', label: 'Clear', danger: true, onSelect: set(null) },
    ];
  }, [lane.name, lanes, onOpenTile, select, setTile]);

  return (
    <div className={`flex items-stretch rounded-lg border ${lane.isTarget ? 'border-dashed border-white/15' : 'border-white/10'} bg-black/20 ${lane.play ? '' : 'opacity-60'}`}>
      {/* Lane header column: fixed width so every lane's step 1 lines up. */}
      <div className="w-56 shrink-0 border-r border-white/10 p-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <label htmlFor={`${ids}-name`} className="sr-only">Lane name</label>
          <input
            id={`${ids}-name`}
            name={`${ids}-name`}
            defaultValue={lane.name}
            key={lane.name}
            onBlur={(e) => { if (e.target.value !== lane.name) setLaneOpts(lane.name, { name: e.target.value.trim() }); }}
            className={`${input} w-full font-semibold`}
          />
          {isMaster && <span className={`text-[9px] font-mono uppercase tracking-widest shrink-0 ${MASTER_TEXT}`} title="Master lane: its wrap is the sync boundary">master</span>}
          {lane.isTarget && <span className="text-[9px] font-mono uppercase tracking-widest et-ink-3 shrink-0">@target</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor={`${ids}-div`} className={label}>step</label>
          <select
            id={`${ids}-div`}
            name={`${ids}-div`}
            value={lane.div}
            onChange={(e) => setLaneOpts(lane.name, { div: Number(e.target.value) })}
            className={`${input} form-select`}
            style={{ colorScheme: 'dark' }}
          >
            {DIVS.map((d) => <option key={d} value={d}>1/{d}</option>)}
          </select>
          <label htmlFor={`${ids}-len`} className={label}>×</label>
          <input
            id={`${ids}-len`}
            name={`${ids}-len`}
            type="number"
            min={1}
            max={256}
            value={lane.length}
            onChange={(e) => setLaneOpts(lane.name, { length: Number(e.target.value) })}
            className={`${input} w-14 tabular-nums`}
          />
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono et-ink-2">
          <label className="flex items-center gap-1">
            <input id={`${ids}-play`} name={`${ids}-play`} type="checkbox" checked={lane.play} onChange={(e) => setLaneOpts(lane.name, { play: e.target.checked })} />
            play
          </label>
          <label className="flex items-center gap-1">
            <input id={`${ids}-target`} name={`${ids}-target`} type="checkbox" checked={lane.isTarget} onChange={(e) => setLaneOpts(lane.name, { isTarget: e.target.checked })} />
            target
          </label>
          <span className="ml-auto tabular-nums et-ink-3" title="lap">lap {lap + 1}</span>
        </div>
        <div className="flex items-center gap-1 mt-auto">
          <button type="button" onClick={() => addRow(lane.name)} className={btn} aria-label={`Add a stack row above lane ${lane.name}`}>+ row</button>
          <button type="button" onClick={() => removeLane(lane.name)} className={`${btn} ${DANGER_TEXT} ml-auto`} aria-label={`Remove lane ${lane.name}`}>remove</button>
        </div>
        <div className="text-[10px] font-mono et-ink-3 truncate" title={fired?.title}>{fired?.title ?? ''}</div>
      </div>

      {/* The band: rows of same-size squares. */}
      <div className="p-2 flex flex-col gap-1">
        {lane.rows.map((row, r) => {
          const isRail = r === lane.rows.length - 1;
          return (
            <div key={r} className="flex items-center gap-1">
              {row.map((tile, step) => {
                const sel: TileSel = { lane: lane.name, row: r, step };
                const isSel = selected?.lane === lane.name && selected.row === r && selected.step === step;
                const isLive = step === liveStep;
                const beatStart = step % Math.max(1, lane.div / 4) === 0;
                const groupGap = step > 0 && step % 4 === 0 ? 'ml-1.5' : '';
                // A rail cell inside a longer shard's span shows the span continuing.
                const spanOwner = !tile && isRail ? row.slice(0, step).findIndex((t, i) => t && t.kind === 'shard' && i + t.steps > step) : -1;
                const covered = spanOwner >= 0;
                const face = tile ? tileFace(tile) : null;
                const resolved = tile && tile.kind === 'shard' ? resolvedFor(tile) : null;
                const title = tile
                  ? `${serializeTile(tile)}${resolved ? ` → ${resolved.stem_name} #${resolved.bar_index}` : tile.kind === 'shard' ? ' → (unresolved)' : ''}`
                  : `${lane.name} row ${r + 1} step ${step + 1}`;
                return (
                  <button
                    key={step}
                    type="button"
                    aria-label={`${lane.name} row ${r + 1} step ${step + 1}${tile ? `: ${serializeTile(tile)}` : covered ? ': held' : ''}`}
                    aria-pressed={isSel}
                    title={title}
                    onClick={() => { select(sel); onOpenTile(); }}
                    onContextMenu={(e) => { e.preventDefault(); select(sel); menu.open(e, sel); }}
                    className={`${CELL} ${groupGap} relative rounded-md border flex flex-col items-center justify-center leading-none transition-[transform,background-color,border-color] duration-75 ${
                      tile
                        ? `${TILE_FILL[tile.kind]} et-ink`
                        : covered
                          ? HELD_FILL
                          : isRail
                            ? `bg-white/4 ${beatStart ? 'border-white/20' : 'border-white/8'} hover:bg-white/8`
                            : `bg-white/2 ${beatStart ? 'border-white/12' : 'border-white/5'} hover:bg-white/6`
                    } ${isLive ? 'ring-2 ring-amber-300/90 scale-105 z-10' : ''} ${isSel ? 'outline-2 outline-offset-1 outline-sky-400/80' : ''}`}
                  >
                    {face ? (
                      <>
                        <span className={`font-mono font-black ${tile?.kind === 'shard' ? 'text-base' : 'text-lg'}`}>{face.glyph}</span>
                        {face.sub ? <span className="text-[8px] font-mono et-ink-2 truncate max-w-10 mt-0.5">{face.sub}</span> : null}
                      </>
                    ) : covered ? (
                      <span className="block h-0.5 w-full bg-amber-400/50 rounded" aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
              {!isRail && (
                <button
                  type="button"
                  onClick={() => removeRow(lane.name, r)}
                  aria-label={`Remove stack row ${r + 1} of lane ${lane.name}`}
                  title="remove row"
                  className={`ml-1 size-6 rounded text-[10px] font-mono et-ink-3 hover:${DANGER_TEXT.split(' ')[0]}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      {menu.position && menu.payload && (
        <ContextMenu position={menu.position} onClose={menu.close} items={menuItems(menu.payload)} minWidth="10rem" />
      )}
    </div>
  );
};

/* ── CODE ────────────────────────────────────────────────────────────────── */

const CodePane: React.FC = () => {
  const text = useLoomStore((s) => s.text);
  const errors = useLoomStore((s) => s.errors);
  const dirty = useLoomStore((s) => s.dirty);
  const running = useLoomStore((s) => s.running);
  const setText = useLoomStore((s) => s.setText);
  const apply = useLoomStore((s) => s.apply);
  const resetStarter = useLoomStore((s) => s.resetStarter);
  const loadTemplate = useLoomStore((s) => s.loadTemplate);
  const [missing, setMissing] = useState<string[]>([]);
  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-white/5">
        <label htmlFor="loom-template" className={label}>sample</label>
        <select
          id="loom-template"
          name="loom-template"
          value=""
          onChange={(e) => { if (e.target.value) setMissing(loadTemplate(e.target.value)); }}
          className={`${input} form-select max-w-44`}
          style={{ colorScheme: 'dark' }}
        >
          <option value="">— load a sample score —</option>
          <optgroup label="Simple">
            {LOOM_TEMPLATES.filter((t) => t.level === 'simple').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </optgroup>
          <optgroup label="Involved">
            {LOOM_TEMPLATES.filter((t) => t.level === 'complex').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </optgroup>
        </select>
        <div className="ml-auto flex gap-1">
          <button type="button" onClick={resetStarter} className={btn}>starter</button>
          <button type="button" onClick={() => apply()} disabled={!dirty || errors.length > 0} className={`${btn} border-amber-400/50`}>Apply ⏎</button>
        </div>
      </div>
      <div className="px-3 py-1 text-[10px] font-mono et-ink-3">
        {dirty ? 'edited' : 'applied'}{running && dirty ? ' · Apply queues to the master wrap' : ''}
        {missing.length > 0 ? ` · not in your library: ${missing.join(', ')}` : ''}
      </div>
      <label htmlFor="loom-code" className="sr-only">Loom score</label>
      <textarea
        id="loom-code"
        name="loom-code"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } }}
        className="flex-1 min-h-40 resize-none bg-transparent px-3 py-2 text-[11px] leading-5 font-mono et-ink focus:outline-none whitespace-pre overflow-auto"
        aria-describedby="loom-code-errors"
      />
      <ul id="loom-code-errors" className="max-h-28 overflow-auto border-t border-white/5 px-3 py-1.5 text-[10px] font-mono text-rose-300" aria-live="polite">
        {errors.length === 0 && <li className="et-ink-3">no errors</li>}
        {errors.map((e, i) => <li key={i}>{e.line ? `line ${e.line}: ` : ''}{e.message}</li>)}
      </ul>
    </div>
  );
};

/* ── TILE ────────────────────────────────────────────────────────────────── */

const TilePane: React.FC = () => {
  const selected = useLoomStore((s) => s.selected);
  const applied = useLoomStore((s) => s.applied);
  const setTile = useLoomStore((s) => s.setTile);
  const lane = selected ? applied.lanes.find((l) => l.name === selected.lane) : undefined;
  const tile = selected && lane ? lane.rows[selected.row]?.[selected.step] ?? null : null;
  if (!selected || !lane) return <p className="p-3 text-[11px] font-mono et-ink-3">Click a square on the plane.</p>;

  const id = `loom-tile-${selected.lane}-${selected.row}-${selected.step}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const update = (t: LoomTile | null) => setTile(selected, t);
  const kind = tile?.kind ?? 'empty';
  const others = applied.lanes.filter((l) => l.name !== lane.name);

  const setKind = (k: string) => {
    if (k === 'empty') return update(null);
    if (k === 'shard') return update({ kind: 'shard', query: { role: 'kick' }, steps: 1, roll: 0 });
    if (k === 'chance') return update({ kind: 'chance', pct: 50 });
    if (k === 'cycle') return update({ kind: 'cycle', period: 4, laps: [2] });
    if (k === 'lock') return update({ kind: 'lock', mode: 'abs', params: { gain: -6 } });
    if (k === 'jump') return update({ kind: 'jump', target: others[0]?.name ?? '' });
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-[11px] font-mono et-ink">
      <div className="et-ink-2">
        <span className="et-ink font-semibold">{lane.name}</span> · row {selected.row + 1}{selected.row === lane.rows.length - 1 ? ' (rail)' : ''} · step {selected.step + 1}
        <span className="ml-2 et-ink-3">{tile ? serializeTile(tile) : '(empty)'}</span>
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-kind`} className={label}>tile</label>
        <select id={`${id}-kind`} name={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value)} className={`${input} form-select`} style={{ colorScheme: 'dark' }}>
          <option value="empty">empty</option>
          <option value="shard">shard</option>
          <option value="chance">chance gate</option>
          <option value="cycle">cycle gate</option>
          <option value="lock">lock</option>
          <option value="jump">jump</option>
        </select>
      </div>

      {tile?.kind === 'shard' && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Field id={`${id}-role`} label="role">
            <select id={`${id}-role`} name={`${id}-role`} value={tile.query.role ?? ''} onChange={(e) => update({ ...tile, query: { ...tile.query, role: (e.target.value || undefined) as LoomRole | undefined } })} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
              <option value="">any</option>
              {LOOM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field id={`${id}-steps`} label="steps">
            <input id={`${id}-steps`} name={`${id}-steps`} type="number" min={1} max={lane.length} value={tile.steps} onChange={(e) => update({ ...tile, steps: Math.max(1, Number(e.target.value) || 1) })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-entry`} label="song (title or id)">
            <input id={`${id}-entry`} name={`${id}-entry`} value={tile.query.entry ?? ''} placeholder="any in the crate" onChange={(e) => update({ ...tile, query: { ...tile.query, entry: e.target.value || undefined } })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-bar`} label="bar #">
            <input id={`${id}-bar`} name={`${id}-bar`} type="number" min={0} value={tile.query.bar ?? ''} onChange={(e) => update({ ...tile, query: { ...tile.query, bar: e.target.value === '' ? undefined : Number(e.target.value) } })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-emin`} label="energy ≥">
            <input id={`${id}-emin`} name={`${id}-emin`} type="number" min={0} max={1} step={0.05} value={tile.query.energyMin ?? ''} onChange={(e) => update({ ...tile, query: { ...tile.query, energyMin: e.target.value === '' ? undefined : Number(e.target.value) } })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-emax`} label="energy ≤">
            <input id={`${id}-emax`} name={`${id}-emax`} type="number" min={0} max={1} step={0.05} value={tile.query.energyMax ?? ''} onChange={(e) => update({ ...tile, query: { ...tile.query, energyMax: e.target.value === '' ? undefined : Number(e.target.value) } })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-text`} label="word / chord">
            <input id={`${id}-text`} name={`${id}-text`} value={tile.query.text ?? ''} onChange={(e) => update({ ...tile, query: { ...tile.query, text: e.target.value || undefined } })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-roll`} label="re-roll every N laps (0 = never)">
            <input id={`${id}-roll`} name={`${id}-roll`} type="number" min={0} max={64} value={tile.roll} onChange={(e) => update({ ...tile, roll: Math.max(0, Number(e.target.value) || 0) })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-shardid`} label="pinned shard id">
            <input id={`${id}-shardid`} name={`${id}-shardid`} value={tile.query.shardId ?? ''} onChange={(e) => update({ ...tile, query: { ...tile.query, shardId: e.target.value || undefined } })} className={`${input} w-full`} />
          </Field>
        </div>
      )}

      {tile?.kind === 'chance' && (
        <Field id={`${id}-pct`} label="lets what is below through (%)">
          <input id={`${id}-pct`} name={`${id}-pct`} type="number" min={0} max={100} value={tile.pct} onChange={(e) => update({ ...tile, pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} className={`${input} w-24`} />
        </Field>
      )}

      {tile?.kind === 'cycle' && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Field id={`${id}-period`} label="period (laps)">
            <input id={`${id}-period`} name={`${id}-period`} type="number" min={2} max={32} value={tile.period} onChange={(e) => update({ ...tile, period: Math.max(2, Math.min(32, Number(e.target.value) || 2)) })} className={`${input} w-full`} />
          </Field>
          <Field id={`${id}-laps`} label="open on laps (1-based, comma)">
            <input id={`${id}-laps`} name={`${id}-laps`} value={tile.laps.join(',')} onChange={(e) => update({ ...tile, laps: e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= tile.period) })} className={`${input} w-full`} />
          </Field>
        </div>
      )}

      {tile?.kind === 'lock' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label htmlFor={`${id}-mode`} className={label}>mode</label>
            <select id={`${id}-mode`} name={`${id}-mode`} value={tile.mode} onChange={(e) => update({ ...tile, mode: e.target.value as 'abs' | 'rel' })} className={`${input} form-select`} style={{ colorScheme: 'dark' }}>
              <option value="abs">= absolute</option>
              <option value="rel">+ relative</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {LOCK_PARAMS.map((p: LockParam) => (
              <Field key={p} id={`${id}-lock-${p}`} label={`${p}${LIVE_LOCK_PARAMS.has(p) ? '' : ' (not yet live)'}`}>
                <input
                  id={`${id}-lock-${p}`}
                  name={`${id}-lock-${p}`}
                  type="number"
                  step={p === 'gain' ? 1 : 0.05}
                  value={tile.params[p] ?? ''}
                  placeholder="—"
                  onChange={(e) => {
                    const params = { ...tile.params };
                    if (e.target.value === '') delete params[p]; else params[p] = Number(e.target.value);
                    update({ ...tile, params });
                  }}
                  className={`${input} w-full ${LIVE_LOCK_PARAMS.has(p) ? '' : 'opacity-60'}`}
                />
              </Field>
            ))}
          </div>
        </div>
      )}

      {tile?.kind === 'jump' && (
        <Field id={`${id}-target`} label="fly to lane (from the step after)">
          <select id={`${id}-target`} name={`${id}-target`} value={tile.target} onChange={(e) => update({ ...tile, target: e.target.value })} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
            {others.map((l) => <option key={l.name} value={l.name}>{l.name}{l.isTarget ? ' (@target)' : ''}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
};

const Field: React.FC<{ id: string; label: string; children: React.ReactNode }> = ({ id, label: text, children }) => (
  <div className="flex flex-col gap-0.5">
    <label htmlFor={id} className={label}>{text}</label>
    {children}
  </div>
);

/* ── CRATE ───────────────────────────────────────────────────────────────── */

const CratePane: React.FC = () => {
  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const load = useLibraryStore((s) => s.load);
  const crate = useShardIndexStore((s) => s.crate);
  const status = useShardIndexStore((s) => s.status);
  const byEntry = useShardIndexStore((s) => s.byEntry);
  const addToCrate = useShardIndexStore((s) => s.addToCrate);
  const removeFromCrate = useShardIndexStore((s) => s.removeFromCrate);
  const selected = useLoomStore((s) => s.selected);
  const applied = useLoomStore((s) => s.applied);
  const setTile = useLoomStore((s) => s.setTile);
  const [browse, setBrowse] = useState<string>('');
  const [role, setRole] = useState<string>('drums');

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  const audio = entries.filter((e) => (e.kind ?? 'audio') === 'audio');
  const title = (id: string) => entries.find((e) => e.id === id)?.title ?? id.slice(0, 8);
  const browseId = browse || crate[0] || '';
  const rows: ShardRow[] = useMemo(() => {
    const all = byEntry[browseId] ?? [];
    const drums = new Set(['drums', 'kick', 'snare', 'hihat', 'cymbals', 'toms']);
    return all.filter((r) => (role === 'drums' ? drums.has(r.role) : r.role === role) && r.beats === 4).slice(0, 48);
  }, [byEntry, browseId, role]);

  const audition = (r: ShardRow) => {
    const when = beatClock.nextGrid('beat');
    shards.releaseLane('audition', when, 0.01);
    void shards.launch(r, { when, durationSec: (r.beats * 60) / beatClock.bpm, lane: 'audition', bpm: beatClock.bpm });
  };
  const pin = (r: ShardRow) => {
    if (!selected) return;
    const lane = applied.lanes.find((l) => l.name === selected.lane);
    const cur = lane?.rows[selected.row]?.[selected.step];
    const steps = cur && cur.kind === 'shard' ? cur.steps : 1;
    setTile(selected, { kind: 'shard', query: { shardId: r.id }, steps, roll: 0 });
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-[11px] font-mono et-ink">
      <div className="flex flex-col gap-1">
        <label htmlFor="loom-crate-add" className={label}>add a song to the crate</label>
        <select
          id="loom-crate-add"
          name="loom-crate-add"
          value=""
          onChange={(e) => { if (e.target.value) addToCrate(e.target.value); }}
          className={`${input} form-select w-full`}
          style={{ colorScheme: 'dark' }}
        >
          <option value="">— choose —</option>
          {audio.filter((e) => !crate.includes(e.id)).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
      </div>
      <ul className="flex flex-col gap-1">
        {crate.length === 0 && <li className="et-ink-3">Empty crate: shard tiles search the whole index.</li>}
        {crate.map((id) => {
          const st = status[id] ?? 'idle';
          const n = byEntry[id]?.length ?? 0;
          const key = byEntry[id]?.find((r) => r.key);
          return (
            <li key={id} className="flex items-center gap-2 rounded border border-white/10 px-2 py-1">
              <span className="truncate et-ink">{title(id)}</span>
              <span className="et-ink-3 shrink-0">
                {st === 'sharding' ? 'sharding…' : st === 'loading' ? 'loading…' : st === 'error' ? 'error' : n ? `${n} shards` : 'no shards'}
                {key ? ` · ${key.key}${key.scale === 'minor' ? 'm' : ''} · ${Math.round(key.bpm)}` : ''}
              </span>
              <button type="button" onClick={() => removeFromCrate(id)} aria-label={`Remove ${title(id)} from the crate`} className="ml-auto et-ink-3 hover:text-rose-300">×</button>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-white/10 pt-2 flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Field id="loom-browse-song" label="browse">
            <select id="loom-browse-song" name="loom-browse-song" value={browseId} onChange={(e) => setBrowse(e.target.value)} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
              {crate.map((id) => <option key={id} value={id}>{title(id)}</option>)}
            </select>
          </Field>
          <Field id="loom-browse-role" label="role">
            <select id="loom-browse-role" name="loom-browse-role" value={role} onChange={(e) => setRole(e.target.value)} className={`${input} form-select w-full`} style={{ colorScheme: 'dark' }}>
              {LOOM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <ul className="flex flex-col gap-0.5 max-h-72 overflow-auto">
          {rows.length === 0 && <li className="et-ink-3">no one-bar shards for this role</li>}
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-white/5">
              <button type="button" onClick={() => audition(r)} aria-label={`Audition ${r.stem_name} bar ${r.bar_index}`} className="text-amber-300 hover:text-amber-200">
                <Play className="w-3 h-3 fill-current" />
              </button>
              <span className="et-ink tabular-nums">#{String(r.bar_index).padStart(3, '0')}</span>
              <span className="et-ink-3">{r.stem_name}</span>
              <span className="et-ink-3 tabular-nums">e{r.energy.toFixed(2)}</span>
              {r.chord ? <span className="et-ink-3">{r.chord}</span> : null}
              {r.words ? <span className="truncate et-ink-3 italic">{r.words}</span> : null}
              <button type="button" onClick={() => pin(r)} disabled={!selected} className={`${btn} ml-auto py-0`} aria-label={`Pin ${r.stem_name} bar ${r.bar_index} to the selected tile`}>pin</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
