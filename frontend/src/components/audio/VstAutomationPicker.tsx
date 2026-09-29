/**
 * The automation panel's "Plugin parameter" section: pick a VST3 insert (on a
 * track, a bus or the master), then one of ITS parameters as the plugin's live
 * host lists them, and add a lane for it. The lane is an ordinary trackFx /
 * busFx / masterFx lane whose key is the parameter's `p<index>`, so it is drawn,
 * edited, played live, frozen, exported and saved exactly as a rack effect's
 * lane is.
 *
 * The parameter list exists only while the plugin runs live (the host answers
 * `get_params`). Picking an insert whose list has not been read yet asks for it;
 * the status beside the picker says where the list is: a dot and one word.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useEditorStore, vstParamIndexOfKey, type AutomationLane, type AutomationTarget } from '../../state/editorStore';
import { useVstLiveStore } from '../../state/vstLiveStore';
import { useVstParamStore, type VstParamView } from '../../state/vstParamStore';
import { vstSessions } from '../../lib/vstLive/sessionRegistry';
import { effectEntryLabel } from './EffectWindows';
import { buildVstAutomationInserts, buildVstParamLaneOptions } from './automationLaneOptions';

const EMPTY: VstParamView[] = [];

/** Ask a running plugin for its parameter list; the answer lands in vstParamStore. */
const askForParams = (entryId: string): void => {
  (vstSessions.get(entryId)?.client as { getParams?: () => void } | undefined)?.getParams?.();
};

/** Where the chosen plugin's parameter list is, as a dot colour and one word. */
function listStatus(status: string, listed: boolean): { dot: string; word: string } {
  if (listed) return { dot: 'bg-emerald-400', word: 'Ready' };
  if (status === 'live') return { dot: 'bg-amber-400 animate-pulse', word: 'Reading' };
  if (status === 'starting') return { dot: 'bg-amber-400 animate-pulse', word: 'Starting' };
  if (status === 'error' || status === 'unavailable') return { dot: 'bg-red-400', word: 'Offline' };
  return { dot: 'bg-zinc-500', word: 'Stopped' };
}

export const VstAutomationPicker: React.FC<{
  lanes: readonly AutomationLane[];
  /** Adds (or finds) the lane for `target` and makes it the one being edited. */
  onAdd: (target: AutomationTarget) => void;
}> = ({ lanes, onAdd }) => {
  const tracks = useEditorStore((s) => s.tracks);
  const buses = useEditorStore((s) => s.buses);
  const masterVstChain = useEditorStore((s) => s.masterVstChain);
  const inserts = useMemo(
    () => buildVstAutomationInserts(tracks, buses, masterVstChain, effectEntryLabel),
    [tracks, buses, masterVstChain],
  );
  const [insertKey, setInsertKey] = useState('');
  const [paramIndex, setParamIndex] = useState('');
  const insert = inserts.find((i) => i.key === insertKey) ?? null;
  // A removed insert leaves nothing chosen rather than a stale choice.
  useEffect(() => {
    if (insertKey && !insert) setInsertKey('');
  }, [insertKey, insert]);

  const entryId = insert?.entryId ?? '';
  const status = useVstLiveStore((s) => (entryId ? s.entries[entryId]?.status ?? 'off' : 'off'));
  const list = useVstParamStore((s) => (entryId ? s.lists[entryId] : undefined)) ?? EMPTY;
  const listed = list.length > 0;

  // Ask the running plugin for its list once it is live and the app has none.
  useEffect(() => {
    if (!entryId || listed || status !== 'live') return;
    askForParams(entryId);
  }, [entryId, listed, status]);

  // The lanes below are named from the same lists: ask each plugin a lane rides
  // for its list once, as soon as it runs live.
  const liveEntries = useVstLiveStore((s) => s.entries);
  const lists = useVstParamStore((s) => s.lists);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const lane of lanes) {
      const id = lane.target.entryId;
      if (!id || vstParamIndexOfKey(lane.target.paramKey) === null) continue;
      if (lists[id] || liveEntries[id]?.status !== 'live' || asked.current.has(id)) continue;
      asked.current.add(id);
      askForParams(id);
    }
  }, [lanes, lists, liveEntries]);

  const params = useMemo(
    () => (insert ? buildVstParamLaneOptions(insert, list, lanes) : []),
    [insert, list, lanes],
  );
  useEffect(() => {
    if (paramIndex && !params.some((p) => String(p.index) === paramIndex)) setParamIndex('');
  }, [paramIndex, params]);

  const uid = useId().replace(/:/g, '');
  const insertId = `vst-automation-insert-${uid}`;
  const paramId = `vst-automation-param-${uid}`;
  const state = listStatus(status, listed);
  const selectClass =
    'flex-1 min-w-0 bg-black/40 text-zinc-300 border border-white/10 rounded px-1.5 py-1 text-xs font-bold focus:outline-hidden focus:ring-1 focus:ring-teal-500/60 disabled:opacity-40';

  return (
    <div className="flex flex-col gap-1 border-b border-white/5 pb-2" role="group" aria-labelledby={`${insertId}-title`}>
      <div className="flex items-center justify-between gap-2">
        <span id={`${insertId}-title`} className="font-display text-xs font-bold uppercase tracking-wider text-teal-300">
          Plugin parameter
        </span>
        {insert && (
          <span className="flex items-center gap-1 text-xs font-bold text-zinc-400" role="status">
            <span className={`w-2 h-2 rounded-full ${state.dot}`} aria-hidden="true" />
            {state.word}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <label htmlFor={insertId} className="sr-only">Plugin to automate</label>
        <select
          id={insertId}
          name="vstAutomationInsert"
          value={insertKey}
          onChange={(e) => { setInsertKey(e.target.value); setParamIndex(''); }}
          disabled={inserts.length === 0}
          className={selectClass}
        >
          <option value="">{inserts.length === 0 ? 'No VST3 inserts yet' : 'Choose a plugin…'}</option>
          {inserts.map((i) => (
            <option key={i.key} value={i.key} className="bg-[#0d0a14] text-zinc-200">{i.label}</option>
          ))}
        </select>
      </div>
      {insert && (
        <div className="flex items-center gap-1">
          <label htmlFor={paramId} className="sr-only">Parameter of {insert.label} to automate</label>
          <select
            id={paramId}
            name="vstAutomationParam"
            value={paramIndex}
            onChange={(e) => setParamIndex(e.target.value)}
            disabled={params.length === 0}
            className={selectClass}
          >
            <option value="">
              {!listed
                ? status === 'live' ? 'Reading its parameters…' : 'Its parameters list once it runs live'
                : params.length === 0 ? 'Every parameter has a lane' : 'Choose a parameter…'}
            </option>
            {params.map((p) => (
              <option key={p.index} value={String(p.index)} className="bg-[#0d0a14] text-zinc-200">{p.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const opt = params.find((p) => String(p.index) === paramIndex);
              if (!opt) return;
              onAdd(opt.target);
              setParamIndex('');
            }}
            disabled={!paramIndex}
            aria-label="Add automation lane for the chosen plugin parameter"
            title="Add lane"
            className="p-1 rounded text-teal-300 hover:text-white hover:bg-teal-600/30 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-teal-300 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
