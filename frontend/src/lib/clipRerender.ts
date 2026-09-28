/**
 * clipRerender — re-render an EDIT MIDI clip's audio through the voice it now
 * has.
 *
 * NOT CALLED BY THE APP: EDIT's render upkeep is the MIDI render queue
 * (state/midiRenderQueue, lib/midiRender), which renders a clip's cache when
 * its voice or notes change, one clip at a time, and Import as tracks queues
 * its voiceless parts there too. This module, its StaleRerenderQueue and its
 * render claims stay only until their removal is approved; their tests still
 * run them. What follows describes the design they were written for.
 *
 * Live playback synthesises a MIDI clip from its note list and honours its
 * program, but every offline bounce reads the pre-rendered `audioBlob`. So
 * without this, assigning "Cello" to a clip made it PLAY cello and EXPORT
 * whatever was selected when it was inserted. WaveformEditor ran this for
 * every clip whose render is stale (lib/clipProgram clipRenderIsStale), which
 * kept the blob and the voice in step for every export path at once.
 *
 * The new render rings out for the new instrument's release, so an untrimmed
 * clip takes the new render's length (lib/clipRenderWindow).
 *
 * One clip at a time: WaveformEditor's instrument-sync pass asks for the
 * stale clips (staleMidiClipIds) whenever a clip's voice or render changes
 * (midiClipVoiceSig), and a StaleRerenderQueue renders them in turn, each clip
 * once while it waits or renders. Before, the pass started a render for every
 * stale clip at once and again for each one still rendering whenever another
 * landed, so 24 stale parts started about 300 renders. A clip whose render
 * another path owns (Import as tracks renders its parts in turn; a MIDI file
 * added to a track renders its own) is claimed there (claimClipRender) and
 * left to it. An owner that gives up without a render (it failed, or the
 * import stopped part way) hands the clip back (releaseClipRender with
 * `unrendered`), and the pass, told through onClipRenderHandedBack, renders it.
 *
 * The render, the peak scan, the picker and the soundfont warm-up are passed
 * in (WaveformEditor gives lib/midiSynth, editorStore and soundfontEngine's),
 * so node tests replay a re-render against the real editor store.
 */
import { useEditorStore, type AudioClip, type EditorTrack } from '../state/editorStore';
import { clipRenderIsStale, clipVoice, renderedVoiceFields, type GlobalVoice } from './clipProgram';
import { renderedWindowFields } from './clipRenderWindow';
import { roundUpToBar } from './meterMap';
import { noteEndStep } from './clipNotes/units';
import type { RollRenderBends } from './pitchBend';
import { clipRenderInput } from './rollClip';
import { midiRenderSig } from './midiRender';
import type { TempoEvent } from './tempoMap';
import type { RollControl } from '../state/pianoRollStore';
import { clipArticulationInstrument, type ArticulationInstrument } from './articulationMap';

export interface ClipRerenderDeps {
  /** lib/midiSynth renderStepNotesToBlob. */
  render: (
    notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
    bpm: number,
    totalSteps: number,
    opts: {
      program?: number;
      bank?: number;
      percussion?: boolean;
      bends?: RollRenderBends;
      tempoMap?: readonly TempoEvent[];
      controls?: readonly RollControl[];
      /** The instrument the notes' articulations resolve against (lib/articulationRender). */
      articulation?: ArticulationInstrument;
    },
  ) => Promise<{ blob: Blob; duration: number }>;
  /** editorStore computePeaks. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array }>;
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
  /** soundfontEngine ensureSoundfontReady, awaited before the render. */
  ensureReady: () => Promise<unknown>;
}

const voiceNow = (clipId: string, global: GlobalVoice) => {
  const { clips, tracks } = useEditorStore.getState();
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const track = tracks.find((t) => t.id === clip.trackId);
  return { clip, track, voice: clipVoice(clip, track, global) };
};

/**
 * Re-render `clipId` when its audio was rendered with another voice than it
 * now has. Resolves true when a new render was written, false when there was
 * nothing to do or the clip changed voice or went away mid-render. Rejects
 * when the render fails, leaving the clip as it was.
 */
export async function rerenderStaleMidiClip(clipId: string, deps: ClipRerenderDeps): Promise<boolean> {
  const before = voiceNow(clipId, deps.global());
  if (!before) return false;
  const { clip, track, voice } = before;
  if (clip.sourceKind !== 'piano-roll' || !clip.sourcePianoRoll?.length) return false;
  if (!clipRenderIsStale(clip, track, deps.global())) return false;
  await deps.ensureReady();
  const bpm = clip.sourceBpm ?? useEditorStore.getState().bpm;
  // A clip with no grid length renders to the bar line after its last note.
  // noteEndStep is a loop: a spread passes one argument per note, and V8
  // refuses past about 125,000.
  const totalSteps = clip.sourceTotalSteps
    ?? roundUpToBar(clip.sourceMeterMap ?? [], noteEndStep(clip.sourcePianoRoll, 1), clip.sourcePickupSteps ?? 0);
  // A clip whose lanes bend renders each note in its lane, so the bend survives the re-render.
  const input = clipRenderInput(clip, totalSteps);
  const rendered = await deps.render(input.notes, bpm, totalSteps, {
    program: voice.program,
    // The bank the clip's own program was chosen in (a roll part's Bank), so the render plays that preset.
    ...(voice.bank ? { bank: voice.bank } : {}),
    percussion: voice.percussion,
    bends: input.bends,
    // The clip's tempo changes, ramps and fermatas, so the new voice plays them too.
    ...(clip.sourceTempoMap?.length ? { tempoMap: clip.sourceTempoMap } : {}),
    // Its part's volume, pan, expression, modulation and pedal (lib/rollClip clipRenderInput).
    ...(input.controls ? { controls: input.controls } : {}),
    // Its notes' articulations, as they resolve for the new voice.
    articulation: clipArticulationInstrument(clip, voice.program, voice.percussion === true),
  });
  const { peaks } = await deps.computePeaks(rendered.blob, 240);
  // Re-read: the user may have deleted, trimmed or re-assigned the clip mid-render.
  const after = voiceNow(clipId, deps.global());
  if (
    !after
    || after.voice.program !== voice.program
    || after.voice.percussion !== voice.percussion
    || (after.voice.bank ?? 0) !== (voice.bank ?? 0)
  ) return false;
  // Derived audio, so no undo step: undo restores clips whose bounce is
  // stale, and this write then follows the undo with the redo stack intact.
  useEditorStore.getState().applyClipRender(clipId, {
    audioBlob: rendered.blob,
    mimeType: 'audio/wav',
    ...renderedWindowFields(after.clip, rendered.duration),
    ...renderedVoiceFields(voice),
    // What the render was made from (lib/midiRender), so a later note edit shows it stale.
    renderSig: midiRenderSig(clip),
  }, peaks);
  return true;
}

// ── One clip at a time ──────────────────────────────────────────────────────

/** Clips whose render another path owns right now. Transient: never saved, never in undo. */
const claimedRenders = new Set<string>();

/**
 * Mark `clipId`'s render as owned by the caller (Import as tracks, a MIDI file
 * added to a track), so the instrument-sync pass leaves the clip to it. Claim
 * before the clip reaches the store and release before writing its render:
 * the write changes the clip's voice signature, and the pass that follows
 * must see the clip unclaimed.
 */
export function claimClipRender(clipId: string): void {
  claimedRenders.add(clipId);
}

/** Listeners told when a claimed clip is handed back unrendered (WaveformEditor's instrument-sync pass). */
const handBackListeners = new Set<() => void>();

/**
 * Hand `clipId` back to the instrument-sync pass. Release it this way right
 * before writing its render: the write changes the clip's voice signature, and
 * the pass that follows sees it. With `unrendered`, the owner gives up without
 * writing one (its render failed, or the import stopped part way), so the
 * listeners are told at once and the pass renders the clip; a clip already
 * released tells no one.
 */
export function releaseClipRender(clipId: string, unrendered = false): void {
  const held = claimedRenders.delete(clipId);
  if (held && unrendered) for (const listener of [...handBackListeners]) listener();
}

/** Be told whenever a claimed clip is handed back unrendered. Returns the unsubscribe. */
export function onClipRenderHandedBack(listener: () => void): () => void {
  handBackListeners.add(listener);
  return () => {
    handBackListeners.delete(listener);
  };
}

/** True while another path owns `clipId`'s render. */
export const clipRenderClaimed = (clipId: string): boolean => claimedRenders.has(clipId);

type VoiceClip = Pick<
  AudioClip,
  'id' | 'trackId' | 'sourceKind' | 'sourcePianoRoll' | 'instrumentProgram' | 'instrumentBank' | 'renderedProgram' | 'renderedPercussion' | 'renderedBank'
>;
type VoiceTrack = Pick<EditorTrack, 'id' | 'instrumentProgram' | 'isPercussion'>;

/**
 * Every piano-roll clip's voice and the voice its render holds, as one string:
 * the instrument-sync pass runs again only when it changes (an instrument
 * assignment or a render landing), never on a clip drag.
 */
export function midiClipVoiceSig(clips: readonly VoiceClip[], tracks: readonly VoiceTrack[], global: GlobalVoice): string {
  return clips
    .filter((c) => c.sourceKind === 'piano-roll')
    .map((c) => {
      const v = clipVoice(c, tracks.find((t) => t.id === c.trackId), global);
      return `${c.id}:${v.program ?? 'x'}${v.percussion ? 'd' : ''}b${v.bank ?? 0}:${c.renderedProgram ?? 'x'}${c.renderedPercussion ? 'd' : ''}b${c.renderedBank ?? 0}`;
    })
    .join('|');
}

/** The clips the instrument-sync pass re-renders: piano-roll clips with notes whose render is stale, none claimed. */
export function staleMidiClipIds(clips: readonly VoiceClip[], tracks: readonly VoiceTrack[], global: GlobalVoice): string[] {
  return clips
    .filter((c) => c.sourceKind === 'piano-roll' && !!c.sourcePianoRoll?.length && !claimedRenders.has(c.id))
    .filter((c) => clipRenderIsStale(c, tracks.find((t) => t.id === c.trackId), global))
    .map((c) => c.id);
}

/** Renders of one clip in a row when its voice keeps changing while it renders. */
const MAX_RERENDER_TURNS = 3;

export interface StaleRerenderQueue {
  /** Queue each clip for a re-render: once while it waits or renders, never a claimed one. */
  request: (clipIds: readonly string[]) => void;
  /** Resolves once nothing waits or renders. */
  idle: () => Promise<void>;
  /** The clips waiting or rendering now. */
  pending: () => string[];
}

/**
 * The instrument-sync pass's renders, one clip at a time
 * (rerenderStaleMidiClip for each). At its turn a clip claimed meanwhile is
 * skipped, and one no longer stale costs nothing. A render thrown away because
 * the clip changed voice while it ran is queued again, at most
 * MAX_RERENDER_TURNS times in a row; a failed render is reported to `onError`
 * and not retried until the pass asks again.
 */
export function createStaleRerenderQueue(deps: ClipRerenderDeps, onError: (clipId: string, error: unknown) => void): StaleRerenderQueue {
  const waiting: string[] = [];
  const pending = new Set<string>();
  const turns = new Map<string, number>();
  let running: Promise<void> | null = null;

  const stillStale = (clipId: string): boolean => {
    const { clips, tracks } = useEditorStore.getState();
    return staleMidiClipIds(clips.filter((c) => c.id === clipId), tracks, deps.global()).length > 0;
  };

  const pump = async (): Promise<void> => {
    while (waiting.length) {
      const clipId = waiting.shift() as string;
      let wrote = false;
      let failed = false;
      try {
        if (!claimedRenders.has(clipId)) wrote = await rerenderStaleMidiClip(clipId, deps);
      } catch (e) {
        failed = true;
        onError(clipId, e);
      }
      pending.delete(clipId);
      const turn = (turns.get(clipId) ?? 0) + 1;
      if (!wrote && !failed && turn < MAX_RERENDER_TURNS && stillStale(clipId)) {
        turns.set(clipId, turn);
        pending.add(clipId);
        waiting.push(clipId);
      } else {
        turns.delete(clipId);
      }
    }
  };

  /**
   * Start the pump unless it runs. When it winds down it looks once more, so a
   * request that lands between its last look at the queue and its end (a
   * clip handed back in a promise's continuation) is rendered, not left
   * waiting for the next request.
   */
  const start = (): void => {
    if (running || !waiting.length) return;
    running = pump().finally(() => {
      running = null;
      start();
    });
  };

  return {
    request: (clipIds) => {
      for (const id of clipIds) {
        if (pending.has(id) || claimedRenders.has(id)) continue;
        pending.add(id);
        waiting.push(id);
      }
      start();
    },
    idle: async () => {
      // A pump that starts again as the last one ends is waited for too.
      while (running) await running;
    },
    pending: () => [...pending],
  };
}
