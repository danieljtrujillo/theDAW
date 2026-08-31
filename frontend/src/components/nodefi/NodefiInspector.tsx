/**
 * NodeF.I. inspector — the right rail. Parameters render as real controls,
 * not bare number boxes: ranged params get the SLIDE glass slider (drag,
 * wheel, arrow keys, double-click to reset) with a small precise value box;
 * short selects become segmented pills in the node's accent; stem pickers are
 * chips. Long lists (library entries, effect catalogs) stay as selects.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useNodefiStore } from '../../state/nodefiStore';
import { useLibraryStore } from '../../state/libraryStore';
import { EFFECT_CATEGORIES, EFFECT_DEFAULTS, EFFECT_LABELS } from '../../state/effectChainStore';
import { RACK_EFFECTS, getRackEffect, rackEffectDefaults } from '../../lib/rackEffects';
import { nodeDef, type GraphNode, type ParamField } from '../../lib/nodefiTypes';
import { NODE_ICONS } from './nodeIcons';
import { TendrilParam, CellChoice, BareNumber } from './NodefiControls';

const fieldId = (nodeId: string, key: string) => `nodefi-${nodeId}-${key}`;

/* ── per-field-type controls ─────────────────────────────────────────────── */

function NumberField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useNodefiStore((s) => s.updateParam);
  const id = fieldId(node.id, field.key);
  const value = Number(node.params[field.key] ?? 0);
  // A bounded param earns the tendril; open-ended ones (seed, LFO depth)
  // stay a quiet precise row.
  if (field.min !== undefined && field.max !== undefined) {
    return (
      <TendrilParam
        id={id}
        label={field.label}
        value={value}
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        defaultValue={Number(nodeDef(node.kind).defaults[field.key] ?? field.min)}
        accent={nodeDef(node.kind).accent}
        onChange={(v) => updateParam(node.id, field.key, v)}
      />
    );
  }
  return (
    <BareNumber
      id={id}
      label={field.label}
      value={value}
      min={field.min}
      max={field.max}
      step={field.step}
      onChange={(v) => updateParam(node.id, field.key, v)}
    />
  );
}

function TextField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useNodefiStore((s) => s.updateParam);
  const id = fieldId(node.id, field.key);
  return (
    <div>
      <label htmlFor={id} className="mono-label block mb-0.5">
        {field.label}
      </label>
      <input
        id={id}
        name={id}
        type="text"
        className="compact-input w-full"
        placeholder={field.placeholder}
        value={String(node.params[field.key] ?? '')}
        onChange={(e) => updateParam(node.id, field.key, e.target.value)}
      />
    </div>
  );
}

function SelectField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useNodefiStore((s) => s.updateParam);
  const def = nodeDef(node.kind);
  const options = field.options ?? [];
  const value = String(node.params[field.key] ?? '');
  // Four or fewer choices read better as cells; long lists stay a dropdown.
  if (options.length > 0 && options.length <= 4) {
    return (
      <CellChoice
        label={field.label}
        value={value}
        options={options}
        accent={def.accent}
        columns={Math.min(options.length, 4)}
        onChange={(v) => updateParam(node.id, field.key, v)}
      />
    );
  }
  const id = fieldId(node.id, field.key);
  return (
    <div>
      <label htmlFor={id} className="mono-label block mb-0.5">
        {field.label}
      </label>
      <select
        id={id}
        name={id}
        className="form-select w-full px-1.5 py-1 text-[11px]"
        value={value}
        onChange={(e) => updateParam(node.id, field.key, e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function LibraryField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useNodefiStore((s) => s.updateParam);
  const entries = useLibraryStore((s) => s.entries);
  const load = useLibraryStore((s) => s.load);
  useEffect(() => {
    if (!entries.length) void load();
  }, [entries.length, load]);
  const id = fieldId(node.id, field.key);
  return (
    <div>
      <label htmlFor={id} className="mono-label block mb-0.5">
        {field.label}
      </label>
      <select
        id={id}
        name={id}
        className="form-select w-full px-1.5 py-1 text-[11px]"
        value={String(node.params[field.key] ?? '')}
        onChange={(e) => updateParam(node.id, field.key, e.target.value)}
      >
        <option value="">— pick an entry —</option>
        {entries.map((e) => (
          <option key={e.id} value={e.id}>
            {e.title || e.id}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Stem picker — chips over the song's actual separated stems (+ full mix). */
function StemField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useNodefiStore((s) => s.updateParam);
  const def = nodeDef(node.kind);
  const entryId = String(node.params.libraryId ?? '');
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    setNames(null);
    if (!entryId) return undefined;
    void (async () => {
      try {
        const res = await fetch(`/api/stems/${encodeURIComponent(entryId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { stems?: Array<{ stem_name: string }> };
        if (alive) setNames((data.stems ?? []).map((s) => s.stem_name));
      } catch {
        /* backend down — fall back to the standard names */
      }
    })();
    return () => {
      alive = false;
    };
  }, [entryId]);
  const options = names?.length ? names : ['drums', 'bass', 'guitar', 'piano', 'other', 'vocals'];
  return (
    <div>
      <CellChoice
        label={field.label}
        value={String(node.params[field.key] ?? 'mix')}
        options={[{ value: 'mix', label: 'full mix' }, ...options.map((s) => ({ value: s, label: s }))]}
        accent={def.accent}
        onChange={(v) => updateParam(node.id, field.key, v)}
      />
      {entryId && names !== null && names.length === 0 ? (
        <div className="mt-0.5 text-[10px] font-mono font-semibold text-amber-400/80">
          No stems yet — run stem separation on this song in the Library.
        </div>
      ) : null}
    </div>
  );
}

/** Rack FX picker — the Web Audio rack, grouped; params render as sliders. */
function RackEffectField({ node }: { node: GraphNode }): React.ReactElement {
  const setParams = useNodefiStore((s) => s.setParams);
  const updateParam = useNodefiStore((s) => s.updateParam);
  const effect = String(node.params.effect || 'gater');
  const def = getRackEffect(effect);
  const selId = fieldId(node.id, 'effect');

  const groups = useMemo(() => {
    const by = new Map<string, typeof RACK_EFFECTS[number][]>();
    for (const d of RACK_EFFECTS) {
      const list = by.get(d.group) ?? [];
      list.push(d);
      by.set(d.group, list);
    }
    return Array.from(by.entries());
  }, []);

  const onEffectChange = (next: string) => {
    setParams(node.id, {
      effect: next,
      modParam: String(node.params.modParam ?? ''),
      ...rackEffectDefaults(next),
    });
  };

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={selId} className="mono-label block mb-0.5">
          Effect
        </label>
        <select
          id={selId}
          name={selId}
          className="form-select w-full px-1.5 py-1 text-[11px]"
          value={effect}
          onChange={(e) => onEffectChange(e.target.value)}
        >
          {groups.map(([group, defs]) => (
            <optgroup key={group} label={group}>
              {defs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {def ? <div className="mt-0.5 text-[10px] font-mono text-zinc-400 leading-snug">{def.description}</div> : null}
      </div>
      {(def?.params ?? []).map((p) => (
        <TendrilParam
          key={p.key}
          id={fieldId(node.id, p.key)}
          label={`${p.label} — ${p.key}`}
          value={Number(node.params[p.key] ?? p.default)}
          min={p.min}
          max={p.max}
          step={p.step}
          defaultValue={p.default}
          unit={p.unit}
          accent={nodeDef(node.kind).accent}
          onChange={(v) => updateParam(node.id, p.key, v)}
        />
      ))}
    </div>
  );
}

function EffectField({ node }: { node: GraphNode }): React.ReactElement {
  const setParams = useNodefiStore((s) => s.setParams);
  const updateParam = useNodefiStore((s) => s.updateParam);
  const effect = String(node.params.effect || 'mastering_chain');
  const paramKeys = useMemo(() => Object.keys(EFFECT_DEFAULTS[effect] ?? {}), [effect]);
  const selId = fieldId(node.id, 'effect');

  const onEffectChange = (next: string) => {
    setParams(node.id, { effect: next, ...(EFFECT_DEFAULTS[next] ?? {}) });
  };

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={selId} className="mono-label block mb-0.5">
          Effect
        </label>
        <select
          id={selId}
          name={selId}
          className="form-select w-full px-1.5 py-1 text-[11px]"
          value={effect}
          onChange={(e) => onEffectChange(e.target.value)}
        >
          {Object.entries(EFFECT_CATEGORIES).map(([cat, ids]) => (
            <optgroup key={cat} label={cat}>
              {ids.map((eid) => (
                <option key={eid} value={eid}>
                  {EFFECT_LABELS[eid] ?? eid}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {paramKeys.map((k) => (
        <BareNumber
          key={k}
          id={fieldId(node.id, k)}
          label={k}
          value={Number(node.params[k] ?? EFFECT_DEFAULTS[effect]?.[k] ?? 0)}
          onChange={(v) => updateParam(node.id, k, v)}
        />
      ))}
    </div>
  );
}

/* ── the inspector ───────────────────────────────────────────────────────── */

export function NodefiInspector(): React.ReactElement {
  const selectedId = useNodefiStore((s) => s.selectedId);
  const selectedIds = useNodefiStore((s) => s.selectedIds);
  const node = useNodefiStore((s) => s.nodes.find((n) => n.id === s.selectedId) ?? null);
  const setTitle = useNodefiStore((s) => s.setTitle);
  const removeNode = useNodefiStore((s) => s.removeNode);
  const removeNodes = useNodefiStore((s) => s.removeNodes);
  const duplicateNodes = useNodefiStore((s) => s.duplicateNodes);
  const statusMsg = useNodefiStore((s) => (selectedId ? s.statusMsg[selectedId] : undefined));
  const status = useNodefiStore((s) => (selectedId ? s.status[selectedId] : undefined));

  if (!node) {
    return (
      <div className="p-3 pl-6 text-[12px] text-zinc-500 font-mono font-semibold">Select a node to edit its parameters.</div>
    );
  }

  const def = nodeDef(node.kind);
  const KindIcon = NODE_ICONS[node.kind];
  const titleInputId = `nodefi-title-${node.id}`;

  return (
    <div className="p-3 pl-6 space-y-3 overflow-y-auto h-full">
      {selectedIds.length > 1 && (
        <div className="flex items-center gap-2 rounded border border-teal-500/25 bg-teal-500/8 px-2 py-1.5">
          <span className="text-[11px] font-mono font-bold text-teal-200">{selectedIds.length} nodes selected</span>
          <button
            onClick={() => duplicateNodes(selectedIds)}
            aria-label={`Duplicate ${selectedIds.length} nodes`}
            title="Duplicate selection (Ctrl+D)"
            className="ml-auto p-1 rounded text-zinc-400 hover:text-teal-200 hover:bg-teal-500/15 transition-colors"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => removeNodes(selectedIds)}
            aria-label={`Delete ${selectedIds.length} nodes`}
            title="Delete selection (Del)"
            className="p-1 rounded text-zinc-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Header — the node's orb + kind, underlined in its accent. */}
      <div>
        <div className="flex items-center gap-2">
          <span
            className="relative grid place-items-center w-7 h-7 rounded-full shrink-0"
            style={{
              background: 'radial-gradient(circle at 50% 30%, #332c4d 0%, #191325 46%, #0c0a15 100%)',
              border: `1px solid ${def.accent}88`,
              boxShadow: `0 2px 6px rgba(0,0,0,0.5), 0 0 8px ${def.accent}22`,
            }}
          >
            <KindIcon className="w-3.5 h-3.5" style={{ color: def.accent }} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 text-[12px] font-mono font-bold uppercase tracking-widest text-zinc-300 truncate">
            {def.label}
          </span>
          <button
            onClick={() => removeNode(node.id)}
            aria-label="Delete node"
            title="Delete node"
            className="p-1 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="mt-1.5 h-px" style={{ background: `linear-gradient(90deg, ${def.accent}66, transparent)` }} />
      </div>

      <div>
        <label htmlFor={titleInputId} className="mono-label block mb-0.5">
          Node name
        </label>
        <input
          id={titleInputId}
          name={titleInputId}
          type="text"
          className="compact-input w-full"
          placeholder={def.label}
          value={node.title ?? ''}
          onChange={(e) => setTitle(node.id, e.target.value)}
        />
      </div>

      {def.fields.map((field) => {
        if (field.type === 'effect') return <EffectField key={field.key} node={node} />;
        if (field.type === 'rackeffect') return <RackEffectField key={field.key} node={node} />;
        if (field.type === 'stem') return <StemField key={field.key} node={node} field={field} />;
        if (field.type === 'library') return <LibraryField key={field.key} node={node} field={field} />;
        if (field.type === 'select') return <SelectField key={field.key} node={node} field={field} />;
        if (field.type === 'number') return <NumberField key={field.key} node={node} field={field} />;
        return <TextField key={field.key} node={node} field={field} />;
      })}

      {status === 'error' && statusMsg ? (
        <div className="text-[10px] font-mono text-red-300 bg-red-500/10 border border-red-500/30 rounded p-1.5 wrap-break-word">
          {statusMsg}
        </div>
      ) : null}
    </div>
  );
}
