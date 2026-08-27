/**
 * Audimate inspector — parameter editor for the selected node. Renders the
 * node type's declared fields (text / number / select / library entry), plus
 * the special "effect" field that swaps in the chosen effect's own parameters.
 */
import React, { useEffect, useMemo } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { useAudimateStore } from '../../state/audimateStore';
import { useLibraryStore } from '../../state/libraryStore';
import { EFFECT_CATEGORIES, EFFECT_DEFAULTS, EFFECT_LABELS } from '../../state/effectChainStore';
import { nodeDef, type GraphNode, type ParamField } from '../../lib/audimateTypes';

const fieldId = (nodeId: string, key: string) => `audimate-${nodeId}-${key}`;

function NumberField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useAudimateStore((s) => s.updateParam);
  const id = fieldId(node.id, field.key);
  return (
    <div>
      <label htmlFor={id} className="mono-label block mb-0.5">
        {field.label}
      </label>
      <input
        id={id}
        name={id}
        type="number"
        className="compact-input w-full"
        value={Number(node.params[field.key] ?? 0)}
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        onChange={(e) => updateParam(node.id, field.key, Number(e.target.value))}
      />
    </div>
  );
}

function TextField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useAudimateStore((s) => s.updateParam);
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
  const updateParam = useAudimateStore((s) => s.updateParam);
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
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function LibraryField({ node, field }: { node: GraphNode; field: ParamField }): React.ReactElement {
  const updateParam = useAudimateStore((s) => s.updateParam);
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

function EffectField({ node }: { node: GraphNode }): React.ReactElement {
  const setParams = useAudimateStore((s) => s.setParams);
  const updateParam = useAudimateStore((s) => s.updateParam);
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
      {paramKeys.map((k) => {
        const pid = fieldId(node.id, k);
        return (
          <div key={k}>
            <label htmlFor={pid} className="mono-label block mb-0.5">
              {k}
            </label>
            <input
              id={pid}
              name={pid}
              type="number"
              step="any"
              className="compact-input w-full"
              value={Number(node.params[k] ?? EFFECT_DEFAULTS[effect]?.[k] ?? 0)}
              onChange={(e) => updateParam(node.id, k, Number(e.target.value))}
            />
          </div>
        );
      })}
    </div>
  );
}

export function AudimateInspector(): React.ReactElement {
  const selectedId = useAudimateStore((s) => s.selectedId);
  const selectedIds = useAudimateStore((s) => s.selectedIds);
  const node = useAudimateStore((s) => s.nodes.find((n) => n.id === s.selectedId) ?? null);
  const setTitle = useAudimateStore((s) => s.setTitle);
  const removeNode = useAudimateStore((s) => s.removeNode);
  const removeNodes = useAudimateStore((s) => s.removeNodes);
  const duplicateNodes = useAudimateStore((s) => s.duplicateNodes);
  const statusMsg = useAudimateStore((s) => (selectedId ? s.statusMsg[selectedId] : undefined));
  const status = useAudimateStore((s) => (selectedId ? s.status[selectedId] : undefined));

  if (!node) {
    return (
      <div className="p-3 text-[11px] text-zinc-600 font-mono">Select a node to edit its parameters.</div>
    );
  }

  const def = nodeDef(node.kind);
  const titleInputId = `audimate-title-${node.id}`;

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full">
      {selectedIds.length > 1 && (
        <div className="flex items-center gap-2 rounded border border-purple-500/25 bg-purple-500/8 px-2 py-1.5">
          <span className="text-[10px] font-mono text-purple-200">{selectedIds.length} nodes selected</span>
          <button
            onClick={() => duplicateNodes(selectedIds)}
            aria-label={`Duplicate ${selectedIds.length} nodes`}
            title="Duplicate selection (Ctrl+D)"
            className="ml-auto p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-purple-500/15 transition-colors"
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
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: def.accent }} />
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-400">{def.label}</span>
        <button
          onClick={() => removeNode(node.id)}
          aria-label="Delete node"
          title="Delete node"
          className="ml-auto p-1 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
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
