/**
 * midiRender — a piano-roll clip's audio as an optional cache.
 *
 * A MIDI clip in EDIT is its notes. When it has a program (its own, its
 * track's, or the global picker's) EDIT's synths play those notes live on the
 * audio clock (liveMixer planLiveMidi), and nothing needs its audio until an
 * export, a freeze or an audio edit asks for it. So `audioBlob` on a piano-roll
 * clip is a cached render: present, it holds the notes rendered through the
 * clip's voice; absent, the clip plays live and renders when something needs
 * the audio (lib/midiRenderQueue, one render at a time).
 *
 * This module is the pure half: whether a clip's cache is missing, current or
 * stale; the one render call every path makes; the fields a render writes; and
 * the window a clip with no render has.
 *
 * A cache is stale when the voice it was rendered with is not the voice the
 * clip has now (lib/clipProgram clipRenderIsStale), or when the notes, tempo,
 * lanes, bends or grid length it was rendered from have changed since
 * (`renderSig`). A clip saved before `renderSig` existed has none, and its
 * render is trusted for its notes: every path that wrote notes then rendered
 * with them.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { clipRenderIsStale, renderedVoiceFields, type ClipVoice, type GlobalVoice } from './clipProgram';
import { renderedWindowFields } from './clipRenderWindow';
import { noteEndStep } from './clipNotes/units';
import { roundUpToBar } from './meterMap';
import type { RollRenderBends } from './pitchBend';
import { clipRenderInput } from './rollClip';
import { stepClock } from './rollTempo';
import type { TempoEvent } from './tempoMap';

/** lib/midiSynth renderStepNotesToBlob, injected so node tests render without Web Audio. */
export type MidiStepRender = (
  notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
  bpm: number,
  totalSteps: number,
  opts: { program?: number; percussion?: boolean; bends?: RollRenderBends; tempoMap?: readonly TempoEvent[] },
) => Promise<{ blob: Blob; duration: number }>;

/** The clip fields a render reads. */
export type MidiRenderSource = Pick<
  AudioClip,
  | 'sourceKind'
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceBpm'
  | 'sourceTempoMap'
  | 'sourceTotalSteps'
  | 'sourceMeterMap'
  | 'sourcePickupSteps'
  | 'sourceLanes'
  | 'sourceBends'
>;

/** The clip fields the cache state reads. */
export type MidiCacheClip = MidiRenderSource &
  Pick<AudioClip, 'audioBlob' | 'renderSig' | 'renderedProgram' | 'renderedPercussion' | 'instrumentProgram'>;

/** A piano-roll clip with notes to render. An empty roll renders nothing and plays nothing. */
export const hasMidiNotes = (clip: Pick<AudioClip, 'sourceKind' | 'sourcePianoRoll'>): boolean =>
  clip.sourceKind === 'piano-roll' && (clip.sourcePianoRoll?.length ?? 0) > 0;

/** A clip that has audio to play or decode. Every audio clip does; a piano-roll clip only while it holds a render. */
export const hasClipAudio = (clip: Pick<AudioClip, 'audioBlob'>): boolean => clip.audioBlob instanceof Blob;

/**
 * A clip's grid length: its own, else the bar line after its last note
 * (noteEndStep is a loop, so a long score does not overflow a spread).
 */
export function midiClipTotalSteps(clip: MidiRenderSource): number {
  return clip.sourceTotalSteps
    ?? roundUpToBar(clip.sourceMeterMap ?? [], noteEndStep(clip.sourcePianoRoll ?? [], 1), clip.sourcePickupSteps ?? 0);
}

/** The tempo a clip's notes are read at: its own, else the arrangement's start tempo. */
export const midiClipBpm = (clip: Pick<AudioClip, 'sourceBpm'>, fallbackBpm: number): number =>
  typeof clip.sourceBpm === 'number' && Number.isFinite(clip.sourceBpm) && clip.sourceBpm > 0 ? clip.sourceBpm : fallbackBpm;

/** Seconds from a clip's first step to the end of its grid, under its own clock. */
export function midiClipNominalSec(clip: MidiRenderSource, fallbackBpm: number): number {
  return stepClock(midiClipBpm(clip, fallbackBpm), clip.sourceTempoMap).at(midiClipTotalSteps(clip));
}

/* ── the render signature ───────────────────────────────────────────────── */

/** FNV-1a over a string, as 8 hex digits. */
function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type SigNote = { note: number; step: number; length: number; velocity: number; lane?: number; tick?: number; ticks?: number };

/** Note lists hashed once each: the store replaces a list when it changes, so the list is the cache key. */
const noteHashes = new WeakMap<readonly SigNote[], number>();

function hashNotes(notes: readonly SigNote[] | undefined): number {
  if (!notes) return 0;
  const hit = noteHashes.get(notes);
  if (hit !== undefined) return hit;
  let h = 0x811c9dc5;
  // Hashed in chunks, so a 96,000-note part never builds one giant string.
  let chunk = '';
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i];
    chunk += `${n.note},${n.tick ?? n.step},${n.ticks ?? n.length},${n.velocity},${n.lane ?? ''};`;
    if (chunk.length > 4096) { h = fnv1a(chunk, h); chunk = ''; }
  }
  h = fnv1a(`${chunk}#${notes.length}`, h);
  noteHashes.set(notes, h);
  return h;
}

/**
 * Everything a render of `clip` is made from except its voice, as a short
 * string: the notes it plays, its own notes with their lanes, its tempo and
 * tempo map, its grid length, lanes and bends. Two clips with the same
 * signature and voice render the same audio.
 */
export function midiRenderSig(clip: MidiRenderSource): string {
  const small = JSON.stringify([
    clip.sourceBpm ?? null,
    clip.sourceTempoMap ?? null,
    midiClipTotalSteps(clip),
    clip.sourceLanes ?? null,
    clip.sourceBends ?? null,
  ]);
  const parts = [hashNotes(clip.sourcePianoRoll), hashNotes(clip.sourceRollNotes), fnv1a(small)];
  return parts.map((p) => p.toString(16).padStart(8, '0')).join('');
}

/* ── the cache state ────────────────────────────────────────────────────── */

/** 'none': no render is held. 'current': the render matches the notes and voice. 'stale': it does not. */
export type MidiRenderState = 'none' | 'current' | 'stale';

/**
 * The state of a clip's cached render. A clip that is not a roll clip with
 * notes is 'current': there is nothing to render.
 */
export function midiRenderState(
  clip: MidiCacheClip,
  track: Pick<EditorTrack, 'instrumentProgram' | 'isPercussion'> | null | undefined,
  global: GlobalVoice,
): MidiRenderState {
  if (!hasMidiNotes(clip)) return 'current';
  if (!hasClipAudio(clip)) return 'none';
  if (clipRenderIsStale(clip, track, global)) return 'stale';
  if (clip.renderSig !== undefined && clip.renderSig !== midiRenderSig(clip)) return 'stale';
  return 'current';
}

/* ── rendering ──────────────────────────────────────────────────────────── */

/**
 * Render a clip's notes through `voice`: the notes its lanes play (each in its
 * lane when the lanes bend), at its own tempo and tempo map, over its grid.
 * The one render call every path makes (the queue, the export fill, the
 * assistant's note tools, the roll's EDIT key when it renders).
 */
export async function renderMidiClipAudio(
  clip: MidiRenderSource,
  voice: ClipVoice,
  render: MidiStepRender,
  fallbackBpm: number,
): Promise<{ blob: Blob; duration: number }> {
  const totalSteps = midiClipTotalSteps(clip);
  const input = clipRenderInput(clip, totalSteps);
  return render(input.notes, midiClipBpm(clip, fallbackBpm), totalSteps, {
    program: voice.program,
    percussion: voice.percussion,
    ...(input.bends ? { bends: input.bends } : {}),
    ...(clip.sourceTempoMap?.length ? { tempoMap: clip.sourceTempoMap } : {}),
  });
}

/**
 * The fields a render writes onto `clip`: the audio, its window (a clip that
 * shows its whole source takes the render's length, ring-out included; a
 * trimmed one keeps its window, lib/clipRenderWindow), the voice it holds and
 * the signature of what it was rendered from.
 */
export function midiRenderFields(
  clip: MidiRenderSource & Pick<AudioClip, 'durationSec' | 'sourceDuration' | 'offsetIntoSource' | 'timeStretchRate'>,
  rendered: { blob: Blob; duration: number },
  voice: ClipVoice,
): Partial<AudioClip> {
  return {
    audioBlob: rendered.blob,
    mimeType: 'audio/wav',
    ...renderedWindowFields(clip, rendered.duration),
    ...renderedVoiceFields(voice),
    renderSig: midiRenderSig(clip),
  };
}

/**
 * The window of a piano-roll clip with no render after its notes change: a
 * clip that showed its whole source shows the whole grid again; a trimmed one
 * keeps its trim, shortened only where the grid now ends before it.
 */
export function midiLiveWindowFields(
  clip: Pick<AudioClip, 'durationSec' | 'sourceDuration' | 'offsetIntoSource' | 'timeStretchRate'>,
  nominalSec: number,
): Pick<AudioClip, 'sourceDuration'> & Partial<Pick<AudioClip, 'durationSec'>> {
  return renderedWindowFields(clip, nominalSec);
}

/** A few words on a clip's render, for its menu and title: "Plays live; renders when exported". */
export function midiRenderStateText(state: MidiRenderState, live: boolean): string {
  if (state === 'none') return live ? 'Plays live; renders when exported' : 'Needs a render to be heard';
  if (state === 'stale') return 'Rendered audio is out of date; re-rendering';
  return live ? 'Plays live; rendered audio kept' : 'Plays its rendered audio';
}
