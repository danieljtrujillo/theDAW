/**
 * articulationRender — a MIDI clip's soundfont render split by articulation.
 *
 * A clip's render plays every note through one program. A note whose
 * articulation the soundfont holds as a preset of its own (lib/articulationMap:
 * a string part's pizzicato, GM 46) has to play that preset, on a channel of
 * its own so the part's other notes keep theirs, exactly as EDIT's live MIDI
 * and the roll's PLAY play it. This render does that:
 *
 *   1. every note is shaped by its articulation (a staccato at half its
 *      length), which is all a render with no preset articulation needs, so
 *      it goes through the ordinary step render (lib/midiSynth
 *      renderStepNotesToBlob);
 *   2. otherwise the step render's request (its notes in seconds, wheels and
 *      controllers) is built as usual, each preset articulation's notes move to
 *      a free channel with that preset's program (articulatedRenderPlan), the
 *      part's controllers are copied onto those channels, and the file renders
 *      through the soundfont (soundfontEngine renderMidiBufferToBlobSF).
 *
 * A built-in voice (no program) and a drum track have no presets to split
 * into, so they render shaped and whole.
 *
 * The synth modules load on the first render, so node tests import the plan.
 */
import { articulatedNotes, type ArticulatedInput, type ArticulatedNote, type ArticulationInstrument, type SoundfontArticulationTarget } from './articulationMap';
import type { RenderNote, StepRenderOptions } from './midiSynth';
import { notesToSmf, type SmfControl, type SmfWheel } from './midiWrite';

/** The General MIDI drum channel, never taken by an articulation. */
const DRUM_CHANNEL = 9;

/** A render's notes with each preset articulation on a channel of its own, the controllers copied there, and each channel's program. */
export interface ArticulatedRenderPlan {
  notes: RenderNote[];
  controls: SmfControl[];
  channelPrograms: Array<{ channel: number; program: number; bank: number }>;
}

/**
 * Move each note whose articulation plays a preset (`arts[i]` for `notes[i]`,
 * the same order) to a channel of that preset's: the first channel no note,
 * wheel or drum uses, one per preset in `targets` order. The part's
 * controllers on its own channel (0) are copied to each such channel, so a
 * pizzicato under the part's expression swell swells too. A preset with no
 * free channel left stays on the note's own channel.
 */
export function articulatedRenderPlan(
  notes: readonly RenderNote[],
  arts: readonly Pick<ArticulatedNote<ArticulatedInput>, 'slot'>[],
  targets: readonly SoundfontArticulationTarget[],
  controls: readonly SmfControl[],
  wheel: readonly SmfWheel[] = [],
): ArticulatedRenderPlan {
  const used = new Set<number>([0, DRUM_CHANNEL]);
  for (const n of notes) used.add(n.channel ?? 0);
  for (const w of wheel) used.add(w.channel);
  const free: number[] = [];
  for (let ch = 0; ch < 16; ch += 1) if (!used.has(ch)) free.push(ch);
  const channelOf = targets.map((_, i) => free[i]);
  const outNotes = notes.map((n, i) => {
    const slot = arts[i]?.slot ?? -1;
    const ch = slot >= 0 ? channelOf[slot] : undefined;
    return ch === undefined ? n : { ...n, channel: ch, bend: undefined };
  });
  const channelPrograms: ArticulatedRenderPlan['channelPrograms'] = [];
  const outControls = [...controls];
  targets.forEach((t, i) => {
    const ch = channelOf[i];
    if (ch === undefined || !outNotes.some((n) => n.channel === ch)) return;
    channelPrograms.push({ channel: ch, program: t.program, bank: t.bank });
    for (const c of controls) if (c.channel === 0) outControls.push({ ...c, channel: ch });
  });
  outControls.sort((a, b) => a.sec - b.sec);
  return { notes: outNotes, controls: outControls, channelPrograms };
}

/** A step note as the render takes it, with the articulation a roll note carries. */
export type ArticulatedStepNote = { note: number; velocity: number; step: number; length: number; lane?: number } & Pick<ArticulatedInput, 'articulation'>;

/** The step render's options with the instrument the clip's articulations resolve against. */
export type ArticulatedRenderOptions = StepRenderOptions & { articulation?: ArticulationInstrument };

/**
 * Render step notes through their voice, each played by its articulation and
 * each preset articulation on a channel of its own (see the header). The
 * signature of lib/midiSynth renderStepNotesToBlob, with `articulation` in the
 * options naming the instrument; without it, or with no articulated notes,
 * the render is renderStepNotesToBlob's own.
 */
export async function renderArticulatedStepNotes(
  notes: ArticulatedStepNote[],
  bpm: number,
  totalSteps: number,
  opts: ArticulatedRenderOptions = {},
): Promise<{ blob: Blob; duration: number }> {
  const synth = await import('./midiSynth');
  const { articulation, ...stepOpts } = opts;
  if (!articulation || !notes.some((n) => n.articulation)) return synth.renderStepNotesToBlob(notes, bpm, totalSteps, stepOpts);
  const inst: ArticulationInstrument = { ...articulation, percussion: articulation.percussion || stepOpts.percussion === true };
  const arts = articulatedNotes(notes, inst);
  const shaped = arts.notes.map((a) => a.played);
  if (!arts.targets.length || stepOpts.program === undefined || inst.percussion) return synth.renderStepNotesToBlob(shaped, bpm, totalSteps, stepOpts);
  const request = synth.stepRenderRequest(shaped, bpm, totalSteps, stepOpts);
  const plan = articulatedRenderPlan(request.notes, arts.notes, arts.targets, request.options.controls ?? [], request.options.wheel ?? []);
  const smf = notesToSmf(plan.notes, request.options.program ?? 0, 0, [], 120, request.options.wheel ?? [], {
    bank: request.options.bank ?? 0,
    controls: plan.controls,
    channelPrograms: plan.channelPrograms,
  });
  const { renderMidiBufferToBlobSF } = await import('./soundfontEngine');
  const out = await renderMidiBufferToBlobSF(smf, { minDurationSec: request.nominalSec });
  return { blob: out.blob, duration: Math.max(out.duration, request.nominalSec) };
}
