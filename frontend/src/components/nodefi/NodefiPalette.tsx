/**
 * Nodefi palette — the left rail. Node types are SQUARE tiles in a grid:
 * a glossy orb with the kind's glyph, the name underneath, and the
 * description on mouse-over (title tooltip). Press-and-pull a tile out of its
 * goo to drag a new node onto the canvas (the view renders the stretching
 * strand), or click / press Enter to drop one at the canvas centre. Below the
 * tiles sits the template rack: one ready-made live rig per GANTASMO song.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Save, Search, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { paletteGroups, nodeDef, type NodeKind } from '../../lib/nodefiTypes';
import { NODE_ICONS } from './nodeIcons';
import {
  NODEFI_TEMPLATES,
  resolveTemplateSource,
  type NodefiTemplate,
} from '../../data/nodefiTemplates';
import { useLibraryStore } from '../../state/libraryStore';
import { useNodefiStore } from '../../state/nodefiStore';
import { useNodefiSetsStore, setToFile, type SavedNodeSet } from '../../state/nodefiSetsStore';
import { logError, logInfo } from '../../state/logStore';

interface NodefiPaletteProps {
  onAdd: (kind: NodeKind) => void;
  /** Press on a tile — the view takes over pointer tracking + the goo strand. */
  onOrbDown: (kind: NodeKind, e: React.PointerEvent<HTMLButtonElement>) => void;
  onLoadTemplate: (id: string) => void;
  onLoadSet: (set: SavedNodeSet) => void;
}

/** One square node tile: orb + glyph, name below, hint on hover. */
function NodeTile({
  kind,
  onAdd,
  onOrbDown,
}: {
  kind: NodeKind;
  onAdd: (kind: NodeKind) => void;
  onOrbDown: (kind: NodeKind, e: React.PointerEvent<HTMLButtonElement>) => void;
}): React.ReactElement {
  const def = nodeDef(kind);
  const Icon = NODE_ICONS[kind];
  return (
    <button
      type="button"
      onClick={() => onAdd(kind)}
      onPointerDown={(e) => onOrbDown(kind, e)}
      title={`${def.label} — ${def.hint ?? ''}\nPull the orb onto the canvas, or click to drop at centre.`}
      aria-label={`Add ${def.label} node`}
      className="group/orb aspect-square rounded-lg border border-white/8 bg-white/2 hover:bg-white/5 hover:border-white/20 p-1 flex flex-col items-center justify-center gap-1 transition-colors touch-none select-none min-w-0"
    >
      <span className="relative shrink-0 w-9 h-9 grid place-items-center">
        {/* goo pool under the orb */}
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-3 rounded-full pointer-events-none"
          style={{ background: `radial-gradient(ellipse at 50% 50%, ${def.accent}3d, transparent 70%)`, filter: 'blur(2px)' }}
        />
        <span
          className="relative grid place-items-center w-8 h-8 rounded-full transition-transform duration-150 group-hover/orb:-translate-y-0.5 group-active/orb:scale-95"
          style={{
            background: 'radial-gradient(circle at 50% 30%, #332c4d 0%, #191325 46%, #0c0a15 100%)',
            border: `1px solid ${def.accent}88`,
            boxShadow: `0 4px 10px rgba(0,0,0,0.55), 0 0 10px ${def.accent}22`,
          }}
        >
          <Icon className="w-3.5 h-3.5" style={{ color: def.accent }} strokeWidth={1.75} aria-hidden="true" />
        </span>
      </span>
      <span className="w-full text-center text-[10px] font-semibold leading-tight text-zinc-300 group-hover/orb:text-white transition-colors truncate">
        {def.label}
      </span>
    </button>
  );
}

function TemplateRow({
  tpl,
  resolved,
  onLoad,
}: {
  tpl: NodefiTemplate;
  resolved: boolean;
  onLoad: (id: string) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onLoad(tpl.id)}
      title={`${tpl.description}${resolved ? '' : ` — "${tpl.song}" is not in the library yet; the source nodes load unset.`}`}
      className="group/tpl w-full flex items-center gap-2 rounded-lg border border-white/8 bg-white/2 hover:bg-white/5 hover:border-white/20 px-2 py-1.5 text-left transition-colors"
    >
      <span className="min-w-0 flex-1 text-[12px] font-semibold text-zinc-200 truncate group-hover/tpl:text-white transition-colors">
        {tpl.name}
      </span>
      {!resolved && (
        <span className="shrink-0 flex items-center gap-0.5 text-[10px] font-mono font-semibold text-amber-400/80" title={`"${tpl.song}" not found in the library`}>
          <TriangleAlert className="w-3 h-3" />
        </span>
      )}
    </button>
  );
}

export function NodefiPalette({ onAdd, onOrbDown, onLoadTemplate, onLoadSet }: NodefiPaletteProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [setName, setSetName] = useState('');
  const importRef = useRef<HTMLInputElement | null>(null);
  const entries = useLibraryStore((s) => s.entries);
  const loadLibrary = useLibraryStore((s) => s.load);
  const savedSets = useNodefiSetsStore((s) => s.sets);
  const saveSet = useNodefiSetsStore((s) => s.saveSet);
  const deleteSet = useNodefiSetsStore((s) => s.deleteSet);
  const hasGraph = useNodefiStore((s) => s.nodes.length > 0);
  useEffect(() => {
    if (!entries.length) void loadLibrary();
  }, [entries.length, loadLibrary]);

  const saveCurrent = () => {
    const st = useNodefiStore.getState();
    if (!st.nodes.length) return;
    const entry = saveSet(setName, st.nodes, st.edges);
    setSetName('');
    logInfo('nodefi', `set "${entry.name}" saved (${st.nodes.length} node(s))`);
  };

  const exportSet = (s: SavedNodeSet) => {
    const blob = new Blob([JSON.stringify(setToFile(s), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(s.name || 'set').replace(/[^\w \-.]/g, '')}.nodefi.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const entry = useNodefiSetsStore
        .getState()
        .importSet(JSON.parse(await file.text()), file.name.replace(/\.nodefi\.json$|\.json$/i, ''));
      logInfo('nodefi', `set "${entry.name}" imported`);
    } catch (err) {
      logError('nodefi', `import failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const all = paletteGroups();
    if (!q) return all;
    return all
      .map(({ group, kinds }) => ({
        group,
        kinds: kinds.filter((k) => {
          const def = nodeDef(k);
          return (
            def.label.toLowerCase().includes(q) ||
            (def.hint ?? '').toLowerCase().includes(q) ||
            group.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((g) => g.kinds.length);
  }, [q]);

  const templates = useMemo(
    () =>
      NODEFI_TEMPLATES.filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.song.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      ),
    [q],
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Search (right padding clears the rail's collapse chevron) */}
      <div className="shrink-0 p-2 pb-1 pr-7">
        <label htmlFor="nodefi-node-search" className="sr-only">
          Search nodes and templates
        </label>
        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600 pointer-events-none" />
          <input
            id="nodefi-node-search"
            name="nodefi-node-search"
            type="text"
            className="compact-input w-full pl-6"
            placeholder="Search nodes / templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2 pb-2 space-y-3">
        {groups.map(({ group, kinds }) => (
          <div key={group}>
            <div className="mono-label mb-1">{group}</div>
            <div className="grid grid-cols-3 gap-1">
              {kinds.map((k) => (
                <NodeTile key={k} kind={k} onAdd={onAdd} onOrbDown={onOrbDown} />
              ))}
            </div>
          </div>
        ))}
        {!groups.length && !templates.length ? (
          <div className="text-[10px] font-mono text-zinc-600 px-1 py-2">Nothing matches “{query}”.</div>
        ) : null}

        {templates.length ? (
          <div>
            <div className="mono-label mb-1 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-teal-300/70" aria-hidden="true" />
              Live sets
            </div>
            <div className="space-y-1">
              {templates.map((t) => (
                <TemplateRow
                  key={t.id}
                  tpl={t}
                  resolved={!!resolveTemplateSource(t, entries)}
                  onLoad={onLoadTemplate}
                />
              ))}
            </div>
            <div className="mt-1 text-[10px] font-mono text-zinc-500 leading-relaxed px-1">
              Loading a set replaces the canvas — Ctrl+Z brings your graph back.
            </div>
          </div>
        ) : null}

        {/* My sets — save the current canvas under a name; load / export / delete. */}
        <div>
          <div className="mono-label mb-1 flex items-center gap-1">
            <Save className="w-3 h-3 text-zinc-500" aria-hidden="true" />
            My sets
          </div>
          <div className="flex items-center gap-1 mb-1">
            <label htmlFor="nodefi-set-name" className="sr-only">Name for the saved set</label>
            <input
              id="nodefi-set-name"
              name="nodefi-set-name"
              type="text"
              className="compact-input flex-1 min-w-0"
              placeholder="name this set…"
              value={setName}
              onChange={(e) => setSetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hasGraph) saveCurrent();
              }}
            />
            <button
              type="button"
              onClick={saveCurrent}
              disabled={!hasGraph}
              title="Save the current canvas as a set"
              className="btn-ghost text-[9px] uppercase tracking-wider shrink-0 disabled:opacity-40 disabled:pointer-events-none"
            >
              Save
            </button>
          </div>
          {savedSets.length ? (
            <div className="space-y-1">
              {savedSets.map((s) => (
                <div
                  key={s.id}
                  className="group/set w-full flex items-center gap-1 rounded-lg border border-white/8 bg-white/2 hover:bg-white/5 hover:border-white/20 pl-2 pr-1 py-1 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => onLoadSet(s)}
                    title={`Load "${s.name}" (${s.nodes.length} node(s), saved ${new Date(s.savedAt).toLocaleString()})`}
                    className="min-w-0 flex-1 text-left text-[12px] font-semibold text-zinc-200 truncate group-hover/set:text-white transition-colors"
                  >
                    {s.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => exportSet(s)}
                    title="Export this set to a file"
                    aria-label={`Export set ${s.name}`}
                    className="p-1 rounded text-zinc-600 hover:text-zinc-200 hover:bg-white/10 transition-colors shrink-0"
                  >
                    <Download className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSet(s.id)}
                    title="Delete this set"
                    aria-label={`Delete set ${s.name}`}
                    className="p-1 rounded text-zinc-600 hover:text-red-300 hover:bg-red-500/10 transition-colors shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] font-mono text-zinc-500 px-1">No saved sets yet.</div>
          )}
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            title="Import a .nodefi.json set file"
            className="btn-ghost w-full mt-1 text-[9px] uppercase tracking-wider"
          >
            Import set…
          </button>
          <input
            ref={importRef}
            id="nodefi-set-import"
            name="nodefi-set-import"
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import a saved set file"
            onChange={(e) => void onImportFile(e)}
          />
        </div>
      </div>
    </div>
  );
}
