/**
 * TrackVstInstrument — the instrument slot in an EDIT track header.
 *
 * A MIDI track can play through one of the user's scanned VST3 instruments in
 * place of EDIT's soundfont synths (editorStore EditorTrack.instrument). Empty,
 * the slot is one VST button that opens the list of scanned instruments, laid
 * out like the effect rack's VST browser (EffectWindows FxChainList): one row
 * per plugin, its own name, its vendor muted beside it, and a rescan. Filled,
 * it shows the plugin's name (click it for the plugin's own window, whose
 * settings are captured into the slot), an on/off key, and a key that empties
 * the slot. A dot and one word say how the instrument is sounding live.
 * Beneath it, Articulations picks how the plugin is told a note's
 * articulation: a keyswitch note from C0 up, or Spitfire's UACC on CC 32
 * (EditorTrack articulationSwitch, lib/articulationMap).
 *
 * Every bounce, freeze and export prints the slot through
 * POST /api/vst/render-midi (lib/renderCore printInstrumentTracks).
 */
import React, { useId, useState } from 'react';
import { Loader2, Plug, Power, RefreshCw, X } from 'lucide-react';
import { useEditorStore, type EditorTrack } from '../../state/editorStore';
import type { ChainEntry } from '../../state/effectChainStore';
import { useVstLiveStore, type VstLiveStatus } from '../../state/vstLiveStore';
import { vstSessions } from '../../lib/vstLive/sessionRegistry';
import type { Vst3PluginInfo } from '../../lib/vstClient';
import { isVst3SwitchMode } from '../../lib/articulationMap';
import { useVstStore, vst3InstallHint } from '../../state/vstStore';

/** The scanned plugins that can play MIDI: the instruments. */
export const instrumentPlugins = (plugins: readonly Vst3PluginInfo[]): Vst3PluginInfo[] =>
  plugins.filter((p) => p.category === 'instrument');

/** The one word the status dot carries, per live state. */
export const INSTRUMENT_STATUS_WORD: Record<VstLiveStatus, string> = {
  off: 'Print',
  starting: 'Opening',
  live: 'Live',
  error: 'Error',
  unavailable: 'Print',
};

const STATUS_DOT: Record<VstLiveStatus, string> = {
  off: 'bg-zinc-500',
  starting: 'bg-amber-400',
  live: 'bg-emerald-400',
  error: 'bg-red-400',
  unavailable: 'bg-zinc-500',
};

export interface TrackVstInstrumentProps {
  track: EditorTrack;
  plugins: readonly Vst3PluginInfo[];
  scanning: boolean;
  onRescan: () => void;
  /** Open the instrument's own window; the caller routes its captured state into the slot. */
  onOpenEditor: (entry: ChainEntry) => void;
}

export const TrackVstInstrument: React.FC<TrackVstInstrumentProps> = ({ track, plugins, scanning, onRescan, onOpenEditor }) => {
  const setTrackInstrument = useEditorStore((s) => s.setTrackInstrument);
  const toggleTrackInstrument = useEditorStore((s) => s.toggleTrackInstrument);
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const instrument = track.instrument?.vst ? track.instrument : undefined;
  const live = useVstLiveStore((s) => (instrument ? s.entries[instrument.id] : undefined));
  const installFolder = useVstStore((s) => s.installFolder);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const switchId = useId();
  const available = instrumentPlugins(plugins);
  const name = instrument?.vst?.plugin_name || instrument?.vst?.plugin_path.split(/[\\/]/).pop() || '';
  const status: VstLiveStatus = instrument?.enabled ? (live?.status ?? 'off') : 'off';
  // A live host built before it could take notes processes the plugin but plays none of the part.
  const deaf = status === 'live' && !!instrument && vstSessions.get(instrument.id)?.client.acceptsMidi === false;
  const statusTitle = deaf
    ? 'The installed live VST host predates instrument playback, so the part is silent live; update theDAW to hear it. Bounces, freezes and exports print through the plugin'
    : !instrument?.enabled
    ? 'Switched off: the track plays on EDIT\'s synths'
    : status === 'live'
      ? 'Plays live through the plugin; bounces, freezes and exports print through it'
      : live?.reason
        ? `${live.reason}. Bounces, freezes and exports print through the plugin`
        : 'Bounces, freezes and exports print through the plugin';

  const pick = (pl: Vst3PluginInfo) => {
    setTrackInstrument(track.id, { plugin_path: pl.path, plugin_name: pl.display_name || pl.name });
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-label={instrument ? `Change the VST3 instrument of track ${track.name}` : `Choose a VST3 instrument for track ${track.name}`}
          title="Play this track's MIDI through a VST3 instrument"
          className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-display text-xs font-bold uppercase tracking-wider transition-colors ${
            open || instrument ? 'border-teal-500/40 bg-teal-500/15 text-teal-200' : 'border-white/10 text-zinc-400 hover:bg-white/5 hover:text-white'
          }`}
        >
          <Plug aria-hidden="true" className="w-3 h-3" /> VST
        </button>
        {instrument ? (
          <>
            <button
              type="button"
              onClick={() => onOpenEditor(instrument)}
              aria-label={`Open ${name}, the instrument of track ${track.name}`}
              title={`Open ${name}'s own window`}
              className={`flex-1 min-w-0 truncate text-left px-1 py-0.5 rounded font-sans text-xs font-bold hover:bg-white/5 ${instrument.enabled ? 'text-teal-200' : 'text-zinc-500 line-through'}`}
            >
              {name}
            </button>
            <span className="flex items-center gap-1 shrink-0 font-sans text-xs font-bold text-zinc-300" title={statusTitle}>
              <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${deaf ? 'bg-amber-400' : STATUS_DOT[status]}`} />
              {deaf ? 'Update' : INSTRUMENT_STATUS_WORD[status]}
              <span className="sr-only">{`: ${statusTitle}`}</span>
            </span>
            <button
              type="button"
              onClick={() => toggleTrackInstrument(track.id)}
              aria-pressed={instrument.enabled}
              aria-label={`Track ${track.name} instrument on`}
              title={instrument.enabled ? 'Switch the instrument off: the track plays on EDIT\'s synths' : 'Switch the instrument on'}
              className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${instrument.enabled ? 'bg-teal-500/30 text-teal-200 border-teal-500/60' : 'bg-black/40 text-zinc-500 border-white/10 hover:text-white'}`}
            >
              <Power aria-hidden="true" className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setTrackInstrument(track.id, null)}
              aria-label={`Remove the instrument from track ${track.name}`}
              title="Empty the instrument slot"
              className="w-4 h-4 rounded flex items-center justify-center border shrink-0 bg-black/40 text-zinc-500 border-white/10 hover:text-red-400"
            >
              <X aria-hidden="true" className="w-3 h-3" />
            </button>
          </>
        ) : (
          <span className="font-sans text-xs font-bold text-zinc-500 truncate">No VST instrument</span>
        )}
      </div>
      {instrument && (
        <div className="flex items-center gap-1.5">
          <label htmlFor={switchId} className="shrink-0 font-sans text-xs font-bold text-zinc-400">
            Articulations
          </label>
          <select
            id={switchId}
            name={`track-${track.id}-articulation-switch`}
            value={track.articulationSwitch ?? 'keyswitch'}
            onChange={(e) => {
              if (isVst3SwitchMode(e.target.value)) updateTrack(track.id, { articulationSwitch: e.target.value });
            }}
            title="How the plugin is told a note's articulation"
            className="flex-1 min-w-0 form-select px-1 py-0.5 font-sans text-xs font-bold"
          >
            <option value="keyswitch">Keyswitch notes from C0</option>
            <option value="uacc">UACC on CC 32</option>
          </select>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-0.5 rounded border border-teal-500/20 bg-black/60 p-1">
          <div className="flex items-center justify-between">
            <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400">Instruments ({available.length})</span>
            <button
              type="button"
              onClick={onRescan}
              disabled={scanning}
              className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40"
              title="Rescan VST3 folders"
              aria-label="Rescan VST3 folders"
            >
              {scanning ? <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" /> : <RefreshCw aria-hidden="true" className="w-3 h-3" />}
            </button>
          </div>
          {available.length === 0 ? (
            <p id={listId} className="font-sans text-xs font-bold text-zinc-500 leading-relaxed">
              {scanning ? 'Scanning…' : `No VST3 instruments found. ${vst3InstallHint(installFolder)}`}
            </p>
          ) : (
            <div id={listId} role="listbox" aria-label={`VST3 instruments for track ${track.name}`} className="max-h-32 overflow-y-auto flex flex-col gap-0.5">
              {available.map((pl) => {
                const plName = pl.display_name || pl.name;
                const selected = instrument?.vst?.plugin_path === pl.path;
                return (
                  <button
                    key={pl.path}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(pl)}
                    title={`Play ${track.name} through ${plName}`}
                    className={`flex items-center gap-1.5 text-left px-1.5 py-1 rounded font-sans text-xs font-bold truncate transition-colors border ${
                      selected ? 'bg-teal-500/15 text-teal-300 border-teal-500/30' : 'text-zinc-400 hover:bg-white/5 hover:text-white border-transparent'
                    }`}
                  >
                    <Plug aria-hidden="true" className="w-3 h-3 text-teal-300 shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{plName}</span>
                    {pl.manufacturer && <span className="shrink-0 max-w-20 truncate font-sans text-xs font-bold text-zinc-600">{pl.manufacturer}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
