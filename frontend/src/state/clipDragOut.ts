/**
 * clipDragOut — what EDIT's Ctrl+drag hands to another surface (the Chimera
 * stack, through state/externalDragStore).
 *
 * The press plans the drag and renders nothing: a Ctrl+click selects and a
 * Ctrl+drag inside the timeline copies, and neither needs audio. The drag's
 * audio is what the clips hold now (audio clips, MIDI parts with a current
 * render). A MIDI part with notes and no current render is left for the moment
 * the drag leaves the timeline: then it is rendered through the MIDI render
 * queue one part at a time (clipsWithMidiAudio, muted parts too), the drop
 * takes it when it lands, and the decoded audio of a render made for the drag
 * alone is freed once the drag is over. A part that plays live keeps no render
 * the drag made, so the drag changes neither its header nor its saved file; a
 * part that cannot play live keeps the render EDIT would make for it anyway,
 * marked as made so it can be heard.
 */
import type { AudioDragItem } from '../lib/audioDnD';
import type { GlobalVoice } from '../lib/clipProgram';
import { hasMidiNotes, midiRenderState } from '../lib/midiRender';
import type { AudioClip, EditorTrack } from './editorStore';
import { useExternalDragStore } from './externalDragStore';
import { logInfo } from './logStore';
import { clipsWithMidiAudio } from './midiRenderQueue';

/** A drag out as the press plans it. */
export interface ClipDragOutPlan {
  /** The audio the clips hold now. */
  items: AudioDragItem[];
  /** MIDI parts with no current render, rendered once the drag leaves the timeline. */
  renderIds: string[];
}

/** Plan a drag out of `picked` at the press. Renders nothing. */
export function planClipDragOut(
  picked: readonly AudioClip[],
  tracks: readonly Pick<EditorTrack, 'id' | 'instrumentProgram' | 'isPercussion'>[],
  global: GlobalVoice,
): ClipDragOutPlan {
  const needsRender = (c: AudioClip): boolean =>
    hasMidiNotes(c) && midiRenderState(c, tracks.find((t) => t.id === c.trackId), global) !== 'current';
  return {
    items: picked
      .filter((c): c is AudioClip & { audioBlob: Blob } => c.audioBlob instanceof Blob && !needsRender(c))
      .map((c) => ({ blob: c.audioBlob, mimeType: c.mimeType, label: c.label })),
    renderIds: picked.filter(needsRender).map((c) => c.id),
  };
}

/** True when the plan has anything to hand over. */
export const dragOutHasContent = (plan: Pick<ClipDragOutPlan, 'items' | 'renderIds'>): boolean =>
  plan.items.length > 0 || plan.renderIds.length > 0;

/**
 * The drag has left the timeline: begin the drag to another surface with the
 * audio it has, and render its MIDI parts for this drag alone. The render
 * promise rides the drag (`pending`), and the renders' decoded audio is freed
 * when the drag ends (`onDone`).
 */
export function beginClipDragOut(plan: ClipDragOutPlan): void {
  const ids = new Set(plan.renderIds);
  if (ids.size === 0) {
    useExternalDragStore.getState().begin(plan.items);
    return;
  }
  logInfo('editor', `Rendering ${ids.size} MIDI part(s) for the drag; the drop takes them as they land`);
  const job = clipsWithMidiAudio((c) => ids.has(c.id), undefined, undefined, { includeMuted: true, purpose: 'drag-out' });
  const pending = job.then((out) => out.clips
    .filter((c): c is AudioClip & { audioBlob: Blob } => ids.has(c.id) && c.audioBlob instanceof Blob)
    .map((c) => ({ blob: c.audioBlob, mimeType: c.mimeType, label: c.label })));
  useExternalDragStore.getState().begin(plan.items, {
    pending,
    onDone: () => { void job.then((out) => out.release(), () => undefined); },
  });
}
