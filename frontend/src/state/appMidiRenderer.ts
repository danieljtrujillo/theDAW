/**
 * appMidiRenderer — the MIDI render queue's real renderer, peak scan, picker,
 * soundfont warm-up and live plan (state/midiRenderQueue
 * configureMidiRenderQueue), in one place.
 *
 * App.tsx calls it when the app loads, and WaveformEditor when its module
 * loads. Every tool that reads the queue's picker or live plan (the
 * assistant's note tools, which decide from them whether an edit renders, and
 * every bounce job) reads the app's own from the first moment, whether or not
 * EDIT has been opened. Before a configure the queue reads soundfonts as off
 * and no part as playing live.
 *
 * Every module here is already in App.tsx's eager import graph.
 */
import { renderArticulatedStepNotes } from '../lib/articulationRender';
import { ensureSoundfontReady, getGlobalVoice } from '../lib/soundfontEngine';
import { computePeaks } from './editorStore';
import { liveMidiIfHeard } from './liveMixer';
import { configureMidiRenderQueue } from './midiRenderQueue';

/** Hand the MIDI render queue the app's own renderer, peak scan, picker, warm-up and live plan. */
export function configureAppMidiRenderQueue(): void {
  configureMidiRenderQueue({
    // Each note played by its articulation, a preset articulation on a channel of its own.
    render: renderArticulatedStepNotes,
    computePeaks,
    global: getGlobalVoice,
    ensureReady: ensureSoundfontReady,
    livePlan: liveMidiIfHeard,
  });
}
