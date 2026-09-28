/**
 * NewMidiPartDialog — make an empty MIDI part on the EDIT timeline: pick its
 * instrument, the bar it starts on and its length in bars, and it lands with
 * the arrangement's meters and tempo from that bar, so its bar lines are the
 * arrangement's. The Add-to-track menu's "Empty MIDI part…" opens it.
 *
 * It makes the part through the assistant's own tool (state/editorTools
 * createMidiClip), so the button and editor_create_midi_clip make the same
 * part: on the clicked track, or on a new track named for its instrument, as
 * one undo step. The part plays live on EDIT's synths and holds no rendered
 * audio (lib/midiRender); double-click opens it in the piano roll.
 *
 * It renders the dialog's content only; WaveformEditor puts it in its popover
 * with role="dialog". Every control is native and labelled.
 */
import React, { useId, useMemo, useState } from 'react';
import { useEditorStore } from '../../state/editorStore';
import { createMidiClip } from '../../state/editorTools';
import { midiGlobalVoice } from '../../state/midiRenderQueue';
import { GM_NAMES } from '../../lib/gmInstruments';
import { GM_DRUM_KITS, GM_STANDARD_KIT, drumKitName } from '../../lib/clipProgram';
import { arrangementClipTime, editBarAtSec, editBpmText, editMeterLabel } from '../../lib/editTimeMap';

export interface NewMidiPartDialogProps {
  /** The heading's id, for the dialog's aria-labelledby. */
  headingId: string;
  /** The track the part goes on, or null for a new track. */
  trackId: string | null;
  /** The timeline second the menu was opened at: the part starts on the bar that holds it. */
  atSec: number;
  onClose: () => void;
  /** Hears the new part's clip id once it is made. */
  onCreated?: (clipId: string) => void;
}

/** The sixteen General MIDI families, eight programs each. */
const GM_FAMILIES = [
  'Piano', 'Chromatic percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth effects', 'Ethnic', 'Percussive', 'Sound effects',
];

/** The longest part the dialog makes, in bars (the tool's own limit). */
const MAX_BARS = 4096;

const btn = 'rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:pointer-events-none';
const field = 'rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100 outline-none focus:border-purple-400/60';

export function NewMidiPartDialog({ headingId, trackId, atSec, onClose, onCreated }: NewMidiPartDialogProps) {
  const uid = useId().replace(/:/g, '');
  const tracks = useEditorStore((s) => s.tracks);
  const tempoMap = useEditorStore((s) => s.tempoMap);
  const meterMap = useEditorStore((s) => s.meterMap);
  // The instrument picker, as the MIDI render queue reads it: a melodic part on
  // a new track starts on the picker's program while soundfonts are on.
  const [picker] = useState(midiGlobalVoice);
  const pickerDefault = picker.useSoundfont ? picker.activeProgram : 0;
  const track = trackId ? tracks.find((t) => t.id === trackId) ?? null : null;
  const maps = useMemo(() => ({ tempoMap, meterMap }), [tempoMap, meterMap]);

  const [drumsForNew, setDrumsForNew] = useState(false);
  const drums = track ? track.isPercussion === true : drumsForNew;
  const defaultProgram = track?.instrumentProgram ?? (drums ? GM_STANDARD_KIT : pickerDefault);
  const [program, setProgram] = useState<number>(defaultProgram);
  const [startBar, setStartBar] = useState(String(editBarAtSec(maps, Math.max(0, atSec)).bar + 1));
  const [bars, setBars] = useState('4');
  const [trackName, setTrackName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const instrumentName = drums ? `${drumKitName(program)} kit` : GM_NAMES[program] ?? `Program ${program + 1}`;
  const startNum = Math.floor(Number(startBar));
  const barsNum = Math.floor(Number(bars));
  const valid = Number.isFinite(startNum) && startNum >= 1 && Number.isFinite(barsNum) && barsNum >= 1 && barsNum <= MAX_BARS;
  // What the part will hold: the arrangement's meter and tempo where it starts.
  const preview = valid ? arrangementClipTime(maps, startNum - 1, barsNum) : null;
  const previewText = preview
    ? `Bar ${startNum}: ${editMeterLabel(preview.sourceMeterMap[0].meter)} at ${editBpmText(preview.sourceBpm)} BPM${preview.sourceMeterMap.length > 1 ? `, ${preview.sourceMeterMap.length - 1} meter change(s) inside` : ''}${preview.sourceTempoMap ? ', with tempo changes' : ''}`
    : 'Type a start bar of 1 or more and a length of 1-4096 bars.';

  const switchDrums = (on: boolean) => {
    setDrumsForNew(on);
    setProgram(on ? GM_STANDARD_KIT : pickerDefault);
  };

  const create = () => {
    if (!valid) {
      setError('Type a start bar of 1 or more and a length of 1-4096 bars.');
      return;
    }
    const res = createMidiClip({
      ...(track ? { track_id: track.id } : { track_name: trackName.trim() || undefined }),
      program,
      percussion: drums,
      start_bar: startNum,
      bars: barsNum,
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const clipId = (res.data as { clipId?: string } | undefined)?.clipId;
    if (clipId) onCreated?.(clipId);
    onClose();
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
        <h2 id={headingId} className="text-sm font-bold uppercase tracking-wider text-zinc-200">New MIDI part</h2>
        <button type="button" onClick={onClose} aria-label="Close new MIDI part" className={`${btn} border-white/10 text-zinc-300 hover:bg-white/10`}>
          Close
        </button>
      </div>

      <p className="text-xs font-bold text-zinc-400">
        {track ? `On ${track.name || 'this track'}` : 'On a new track'}
        {track && track.instrumentProgram !== undefined && track.instrumentProgram !== program
          ? ` (the track plays ${drums ? `the ${drumKitName(track.instrumentProgram)} kit` : GM_NAMES[track.instrumentProgram]}; this part keeps its own)`
          : ''}
      </p>

      {!track && (
        <div className="flex items-center gap-2">
          <input
            id={`${uid}-drums`}
            name="new-midi-part-drums"
            type="checkbox"
            checked={drumsForNew}
            onChange={(e) => switchDrums(e.target.checked)}
            className="size-3.5 accent-purple-400"
          />
          <label htmlFor={`${uid}-drums`} className="text-xs font-bold text-zinc-300">Drum part (plays on the drum channel)</label>
        </div>
      )}

      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
        <label htmlFor={`${uid}-program`} className="text-xs font-bold text-zinc-400">{drums ? 'Kit' : 'Instrument'}</label>
        <select
          id={`${uid}-program`}
          name="new-midi-part-program"
          value={program}
          autoFocus
          onChange={(e) => setProgram(Number(e.target.value))}
          className={field}
        >
          {drums
            ? GM_DRUM_KITS.map((k) => <option key={k.program} value={k.program}>{`${k.name} kit`}</option>)
            : GM_FAMILIES.map((family, f) => (
              <optgroup key={family} label={family}>
                {GM_NAMES.slice(f * 8, f * 8 + 8).map((name, i) => (
                  <option key={f * 8 + i} value={f * 8 + i}>{`${f * 8 + i + 1}. ${name}`}</option>
                ))}
              </optgroup>
            ))}
        </select>

        <label htmlFor={`${uid}-start`} className="text-xs font-bold text-zinc-400">Starts at bar</label>
        <input
          id={`${uid}-start`}
          name="new-midi-part-start-bar"
          type="number"
          min={1}
          step="1"
          value={startBar}
          onChange={(e) => { setStartBar(e.target.value); setError(null); }}
          className={`${field} w-24 tabular-nums`}
        />

        <label htmlFor={`${uid}-bars`} className="text-xs font-bold text-zinc-400">Length in bars</label>
        <input
          id={`${uid}-bars`}
          name="new-midi-part-bars"
          type="number"
          min={1}
          max={MAX_BARS}
          step="1"
          value={bars}
          onChange={(e) => { setBars(e.target.value); setError(null); }}
          className={`${field} w-24 tabular-nums`}
        />

        {!track && (
          <>
            <label htmlFor={`${uid}-track`} className="text-xs font-bold text-zinc-400">Track name</label>
            <input
              id={`${uid}-track`}
              name="new-midi-part-track-name"
              type="text"
              value={trackName}
              placeholder={instrumentName}
              onChange={(e) => setTrackName(e.target.value)}
              className={field}
            />
          </>
        )}
      </div>

      <p role="alert" className={`min-h-4 text-xs font-bold ${error ? 'text-amber-300' : 'text-zinc-400'}`}>
        {error ?? previewText}
      </p>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} border-white/10 text-zinc-300 hover:bg-white/10`}>Cancel</button>
        <button type="submit" disabled={!valid} className={`${btn} border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25`}>
          Create part
        </button>
      </div>
    </form>
  );
}
