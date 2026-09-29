/**
 * RollPartInstrument — the VST3 instrument of the roll part being edited,
 * under its Sound in the parts column (RollTrackColumn PartEditor).
 *
 * Shown once the part holds a plugin (its Sound set to one of the scanned
 * VST3 instruments, RollTrack `vstInstrument`). One row names the plugin:
 * pressing the name opens the plugin's own window (state/vstEditorStore, on
 * the live instance the part plays through; its settings are kept with the
 * part), a dot and one word say what the part is doing (Live, Opening,
 * Fallback, Off), a key switches the plugin on and off with its state kept,
 * and a key takes it away. While it is on, Fallback picks the General MIDI
 * program the part plays whenever the plugin cannot and a MIDI export writes,
 * and Articulations picks how the plugin is told a note's articulation.
 */
import React, { useId } from 'react';
import { Plug, Power, X } from 'lucide-react';
import { usePianoRollStore, type RollTrack } from '../../state/pianoRollStore';
import { useVstLiveStore } from '../../state/vstLiveStore';
import { useVstEditorStore } from '../../state/vstEditorStore';
import {
  ROLL_VST_STATE_WORD,
  rollFallbackText,
  rollVstFallbackReason,
  rollVstName,
  rollVstState,
  storeRollVstState,
  type RollVstState,
} from '../../state/rollInstruments';
import { isVst3SwitchMode } from '../../lib/articulationMap';
import { FIELD_LEGEND, FLYOUT_SELECT, KEY_ON, KEY_REST, MINI_ICON_KEY } from './midiDockKit';

const STATE_DOT: Record<RollVstState, string> = {
  off: 'bg-zinc-500',
  opening: 'bg-amber-400',
  live: 'bg-emerald-400',
  fallback: 'bg-red-400',
};

/** What the status word means for the part, in a sentence. */
export function rollVstStateTitle(part: Pick<RollTrack, 'program' | 'channel'>, state: RollVstState, reason: string | null): string {
  const fallback = rollFallbackText(part);
  if (state === 'live') return 'The part plays through the plugin. The EDIT key sends it with the part, and EDIT prints it in every bounce, freeze and export.';
  if (state === 'opening') return `The plugin is starting. The part plays ${fallback} until it is live.`;
  if (state === 'fallback') return `${reason ? `${reason[0].toUpperCase()}${reason.slice(1)}` : 'The plugin could not start'}. The part plays ${fallback} instead.`;
  return `Switched off: the part plays ${fallback}. The plugin and its settings are kept.`;
}

export const RollPartInstrument: React.FC<{
  track: RollTrack;
  /** The Fallback select's options: the Sound select's own, without the plugins. */
  fallbackOptions: React.ReactNode;
  fallbackValue: string;
  onFallback: (value: string) => void;
}> = ({ track, fallbackOptions, fallbackValue, onFallback }) => {
  const entry = track.vstInstrument;
  // The status reads the live row: subscribing to it re-renders the word as the session moves.
  useVstLiveStore((s) => (entry ? s.entries[entry.id]?.status : undefined));
  useVstLiveStore((s) => (entry ? s.entries[entry.id]?.reason : undefined));
  const headingId = useId();
  if (!entry?.vst) return null;
  const name = rollVstName(entry);
  const state = rollVstState(entry.id);
  const title = rollVstStateTitle(track, state, rollVstFallbackReason(entry.id));
  const roll = usePianoRollStore.getState;
  const openEditor = () => {
    const current = usePianoRollStore.getState().tracks.find((t) => t.id === track.id)?.vstInstrument;
    if (!current?.vst) return;
    // The offline copy's sink, for a machine with no live host: its state was captured by the offline renderer.
    useVstEditorStore.getState().open(current, (entryId, raw) => storeRollVstState(entryId, raw, 'pedalboard'));
  };
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-1 rounded-xs border border-white/10 bg-black/30 p-1" data-part-instrument="">
      <div className="flex items-center gap-1">
        <span id={headingId} className={FIELD_LEGEND}>VST3 instrument</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 shrink-0 font-sans text-[12px] font-bold et-ink-2" title={title} data-part-instrument-state={state}>
          <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${STATE_DOT[state]}`} />
          {ROLL_VST_STATE_WORD[state]}
          <span className="sr-only">{`: ${title}`}</span>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={openEditor}
          disabled={!entry.enabled}
          aria-label={`Open ${name}, the instrument of ${track.name}`}
          title={entry.enabled ? `Open ${name}'s own window: what you set there stays with the part` : 'Switch the plugin on to open it'}
          className={`flex-1 min-w-0 inline-flex items-center gap-1 truncate text-left rounded-xs px-1 py-0.5 font-sans text-[12px] font-bold ${KEY_REST}`}
        >
          <Plug aria-hidden="true" className="w-3 h-3 shrink-0" />
          <span className={`truncate ${entry.enabled ? '' : 'line-through'}`}>{name}</span>
        </button>
        <button
          type="button"
          onClick={() => roll().setTrackVstEnabled(track.id, !entry.enabled)}
          aria-pressed={entry.enabled}
          aria-label={`${track.name} plays through ${name}`}
          title={entry.enabled ? 'Switch the plugin off: the part plays its program, and the plugin keeps its settings' : 'Switch the plugin on'}
          className={`${MINI_ICON_KEY} ${entry.enabled ? KEY_ON : KEY_REST}`}
        >
          <Power aria-hidden="true" className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => roll().setTrackVstInstrument(track.id, null)}
          aria-label={`Remove ${name} from ${track.name}`}
          title="Take the plugin away: the part plays its program (Ctrl+Z brings it back)"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
        >
          <X aria-hidden="true" className="w-3 h-3" />
        </button>
      </div>
      {entry.enabled && (
        <>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="roll-part-fallback" className={FIELD_LEGEND}>Fallback</label>
            <select
              id="roll-part-fallback"
              name="roll-part-fallback"
              value={fallbackValue}
              onChange={(e) => onFallback(e.target.value)}
              title="The General MIDI program the part plays whenever the plugin cannot (while it opens, if it fails) and that a MIDI export writes"
              className={FLYOUT_SELECT}
            >
              {fallbackOptions}
            </select>
          </div>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="roll-part-articulations" className={FIELD_LEGEND}>Articulations</label>
            <select
              id="roll-part-articulations"
              name="roll-part-articulations"
              value={track.articulationSwitch ?? 'keyswitch'}
              onChange={(e) => {
                if (isVst3SwitchMode(e.target.value)) roll().setTrackArticulationSwitch(track.id, e.target.value);
              }}
              title="How the plugin is told a note's articulation"
              className={FLYOUT_SELECT}
            >
              <option value="keyswitch">Keyswitch notes from C0</option>
              <option value="uacc">UACC on CC 32</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
};
