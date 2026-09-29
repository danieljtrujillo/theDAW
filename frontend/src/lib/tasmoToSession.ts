// Convert a loaded .tasmo project into a DawProject the Session grid can render,
// so theDAW's own saved projects open in the Session tab alongside Ableton sets.
//
// A .tasmo saved FROM a session grid carries real scene indices and scene names,
// and those are restored verbatim. Only a project with no grid of its own (an
// arrangement-only .tasmo) falls back to laying each track's clips into scene
// rows in start-time order (track = column, clip = scene row). Audio clips keep
// their absolute on-disk path (the load step relinks embedded audio to disk, and
// /api/project/clip-audio serves any absolute path — see dawImportClient's
// dawImportAudioUrl). MIDI clips carry step-based notes, converted here to the
// seconds-based shape the grid renders. A note the file already holds in
// seconds (an imported set's, and every MIDI cell PERFORM saves) is kept as it is.

import type { DawProject, DawTrack, DawClip, DawDevice } from './dawImportClient';
import { bankSelectOf, gmProgramOf, playedNotesFromRoll, tasmoClipBpm, tasmoMeterToClip, ticksMatching, type TasmoProjectLoaded } from './projectClient';
import { MIN_NOTE_TICKS, PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { parseFollowAction } from './followAction';
import { MIN_NOTE_STEPS } from '../state/pianoRollStore';
import { spanSec, stepClock } from './rollTempo';

/** A saved note's start and length in seconds, or null for a note in roll steps.
 *  The start fields are the ones lib/projectImport reads a seconds note by. */
function secondsNote(n: Record<string, number>): { start: number; duration: number } | null {
  const start = [n.start, n.startSec, n.start_time, n.time].find((v) => typeof v === 'number' && Number.isFinite(v));
  if (start === undefined) return null;
  const duration = [n.duration, n.durationSec, n.dur, n.length_sec].find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return { start: Math.max(0, start), duration: duration ?? 0.25 };
}

/** A saved clip's or track's program, bank and sound bank, each only when the
 *  file has one, read as EDIT's loader reads them: a whole program 0-127 (the
 *  file is hand-editable) and a bank only beside a program. */
function voiceFields(v: {
  instrument_program?: number | null;
  instrument_bank?: number | null;
  instrument_bank_id?: string | null;
}): Pick<DawTrack, 'instrument_program' | 'instrument_bank' | 'instrument_bank_id'> {
  const program = gmProgramOf(v.instrument_program);
  if (program === undefined) return {};
  const bank = bankSelectOf(v.instrument_bank);
  return {
    instrument_program: program,
    ...(bank > 0 ? { instrument_bank: bank } : {}),
    ...(v.instrument_bank_id ? { instrument_bank_id: v.instrument_bank_id } : {}),
  };
}

export function tasmoLoadedToDawProject(loaded: TasmoProjectLoaded): DawProject {
  const bpm = loaded.tempo || 120;

  const tracks: DawTrack[] = loaded.tracks.map((t, ti) => {
    // A file written from a real grid already knows where every clip goes.
    const hasGrid = t.clips.some((c) => c.scene_index != null || c.slot_index != null);
    const sorted = hasGrid
      ? [...t.clips]
      : [...t.clips].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
    const clips: DawClip[] = sorted.map((c, ci) => {
      // The notes as they sound: `midi_notes` when the file carries them, else
      // the roll notes unrolled across the clip's lanes, which is all a
      // piano-roll clip saved with only its roll notes has (clipNotesToTasmo).
      const stepNotes: Array<Record<string, number>> =
        Array.isArray(c.midi_notes) && c.midi_notes.length > 0
          ? c.midi_notes
          : c.clip_type === 'midi'
            ? playedNotesFromRoll(tasmoMeterToClip(c)).map((n) => ({ note: n.note, step: n.step, length: n.length, velocity: n.velocity }))
            : [];
      const isMidi = c.clip_type === 'midi' && stepNotes.length > 0;
      // Steps are 16ths at the tempo the clip's notes were written at, through
      // its tempo map when it has one (lib/rollTempo stepClock).
      const clock = stepClock(tasmoClipBpm(c, bpm), isMidi ? tasmoMeterToClip(c).sourceTempoMap : undefined);
      return {
        name: c.name || `Clip ${ci + 1}`,
        start_time: c.start_time ?? 0,
        end_time: c.end_time ?? 0,
        file_path: !isMidi ? (c.audio_file ?? null) : null,
        midi_notes: isMidi
          ? stepNotes.map((n) => {
              const sec = secondsNote(n);
              if (sec) {
                return { pitch: Number(n.pitch ?? n.note ?? n.midi ?? 60), ...sec, velocity: Number(n.velocity ?? 100) };
              }
              const length = Number(n.length ?? 1);
              // The note's own ticks when the file carries them, else its own
              // length in steps down to the roll's one tick (a missing or
              // non-positive one reads as one step): flooring it to a step
              // turned a saved triplet sixteenth into a full sixteenth.
              const ticks = ticksMatching(n.ticks, length, MIN_NOTE_TICKS);
              const steps = ticks !== undefined ? ticks / (PPQ / ROLL_STEPS_PER_BEAT) : length > 0 ? Math.max(MIN_NOTE_STEPS, length) : 1;
              return {
                pitch: Number(n.note ?? n.pitch ?? 60),
                start: clock.at(Number(n.step ?? 0)),
                duration: spanSec(clock, Number(n.step ?? 0), steps),
                velocity: Number(n.velocity ?? 100),
              };
            })
          : null,
        track_index: c.track_index ?? ti,
        scene_index: c.scene_index ?? (hasGrid ? null : ci),
        slot_index: c.slot_index ?? (hasGrid ? null : ci),
        scene_name: null,
        // Trim + loop survive the round-trip: a stem clip saved as a loop must
        // SUSTAIN when launched, not one-shot from sample 0.
        offset_into_source: c.offset_into_source ?? 0,
        loop_start: c.loop_start ?? null,
        loop_end: c.loop_end ?? null,
        loop_on: (c.loop_end ?? 0) > (c.loop_start ?? 0),
        // The clip's follow action, if the file carries one this build can act
        // on. Storage is tolerant (every backend field is defaulted so an older
        // file validates); interpretation is not, so an unknown kind loads as
        // no rule rather than as some other rule.
        followAction: parseFollowAction(c.follow_action),
        // The clip's own voice, which the grid renders it with ahead of its track's.
        ...voiceFields(c),
      };
    });
    return {
      name: t.name || `Track ${ti + 1}`,
      type: t.type === 'midi' ? 'midi' : 'audio',
      // The column's voice: every MIDI cell on it renders with this program,
      // bank and drum channel unless the cell has a program of its own.
      ...voiceFields(t),
      ...(t.is_percussion ? { is_percussion: true } : {}),
      volume_db: t.volume_db ?? 0,
      pan: t.pan ?? 0,
      mute: !!t.mute,
      solo: !!t.solo,
      color: t.color ?? null,
      clips,
      // A .tasmo track's saved FX chain becomes the grid's live device chain,
      // exactly like an imported .als set's devices: built-in entries build the
      // live rack; vst3 entries stay listed-but-inert (the same behavior as
      // EDIT). Without this a saved set reached PERFORM with a bare
      // passthrough, so nothing existed for fx routes (the Sway XY / deck
      // assignments) to hit.
      devices: (t.effect_chain ?? []).map<DawDevice>((n) => ({
        name: n.effect_name,
        plugin_type: n.node_type === 'vst3' ? 'vst3' : 'builtin',
        // Carry the real plugin path: with it null, dawDeviceToEffectNode's
        // plugin test failed and a VST node fell into the BUILTIN branch,
        // where its display name could pattern-match a rack effect ("…Verb"
        // -> reverb at defaults). With the path present it classifies as
        // vst3 and stays cleanly inert in the live grid, exactly like EDIT.
        plugin_path: n.vst_state?.plugin_path ?? null,
        parameters: n.parameters ?? {},
        bypass: !!n.bypass,
        is_instrument: false,
        is_rack: false,
      })),
    };
  });

  return {
    source_daw: 'tasmo',
    source_version: '',
    name: loaded.project_name || 'theDAW Project',
    tempo: bpm,
    time_signature: (loaded.time_signature?.length === 2 ? loaded.time_signature : [4, 4]) as [number, number],
    sample_rate: loaded.sample_rate || 44100,
    tracks,
    locators: [],
    controller_mappings: [],
    scenes: loaded.scenes ?? [],
    plugins_used: [],
    warnings: [],
    missing_files: [],
  };
}
