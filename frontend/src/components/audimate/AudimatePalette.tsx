/** Audimate palette — grouped node types; clicking one drops it on the canvas. */
import React from 'react';
import { Plus } from 'lucide-react';
import { paletteGroups, nodeDef, type NodeKind } from '../../lib/audimateTypes';

export function AudimatePalette({ onAdd }: { onAdd: (kind: NodeKind) => void }): React.ReactElement {
  return (
    <div className="p-2 space-y-3 overflow-y-auto h-full">
      {paletteGroups().map(({ group, kinds }) => (
        <div key={group}>
          <div className="mono-label mb-1">{group}</div>
          <div className="space-y-1">
            {kinds.map((k) => {
              const def = nodeDef(k);
              return (
                <button
                  key={k}
                  onClick={() => onAdd(k)}
                  title={`Add ${def.label} node`}
                  className="w-full flex items-center gap-2 rounded border border-white/8 bg-white/2 hover:bg-white/5 hover:border-white/20 px-2 py-1.5 text-left transition-colors"
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: def.accent }} />
                  <span className="text-[11px] text-zinc-200 flex-1">{def.label}</span>
                  <Plus className="w-3 h-3 text-zinc-500" />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
