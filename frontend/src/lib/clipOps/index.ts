/**
 * clipOps — the editor's clip/timeline capability layer.
 *
 * Two halves, deliberately separated by whether they need a browser:
 *
 * - `./timeline` is pure geometry over `AudioClip` records. Clip in, clip (or
 *   plan) out, no store, no DOM, no audio. Failures that a user could have
 *   caused come back as `{ ok: false, error }` rather than exceptions.
 * - `./audioOps` is the sample-domain work — reverse, normalize, concatenate,
 *   fade, and the MIDI re-renders — taking and returning `Blob`s through an
 *   injected `OfflineAudioContext` factory. These throw.
 *
 * Nothing here commits anything: wiring these into `editorStore` is a separate
 * job, so a caller can plan an edit, show the user what it would do, and only
 * then apply it.
 */
export {
  MAX_BPM,
  MIN_BPM,
  MIN_CLIP_SEC,
  crossfadePlan,
  duplicateClip,
  mergePlan,
  nudgeClip,
  selectRange,
  setClipProps,
  setClipSourceBpm,
  stretchKindOf,
  stretchPlan,
  trimClip,
} from './timeline';
export type {
  ClipOpResult,
  ClipPropPatch,
  CrossfadePlan,
  MergePlan,
  RangeQuery,
  StretchPlan,
  TrimBounds,
} from './timeline';

export {
  DEFAULT_SAMPLE_RATE,
  applyFadesToBlob,
  bounceMidiClip,
  concatBlobs,
  defaultOfflineCtxFactory,
  defaultStepNoteRenderer,
  normalizeBlob,
  reverseBlob,
  stretchMidiClip,
} from './audioOps';
export type {
  AudioOpsContext,
  FadeOptions,
  IoOptions,
  MidiRenderOptions,
  NormalizeOptions,
  OfflineCtxFactory,
  RenderedAudio,
  StepNote,
  StepNoteRenderer,
} from './audioOps';
