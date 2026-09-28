/**
 * rollBounce — the piano roll's EDIT key: put the roll's notes on the EDIT
 * timeline as a MIDI clip.
 *
 * A roll linked to an EDIT clip (`editingClipId`) writes that clip in place,
 * and it plays through the clip's own voice (lib/clipProgram rollVoice). An
 * unlinked roll, or one whose clip is gone, lands on a new track that holds
 * the roll's own program (the Vocal2MIDI panel's voice) or else the global
 * picker's, so changing the picker later does not re-voice the part.
 *
 * A clip's audio is an optional render (lib/midiRender), and the EDIT key
 * renders nothing itself. It writes the notes, the roll's meter map, pickup,
 * lanes, bends and tempo map. A new part, and a linked part that shows its
 * whole source, take the whole grid as their window; a linked part the user
 * trimmed or split in EDIT keeps its window, shortened only where the new
 * grid ends first (lib/midiRender midiLiveWindowFields), so a split half sent
 * back from the roll stays that half and never covers its neighbour. A part
 * with a program plays live on EDIT's synths and renders when an export needs
 * it, so a 24-part score sent part by part holds no audio. A part with no
 * program cannot play live: its render is queued (state/midiRenderQueue, one
 * render at a time) and marked as made so it can be heard, so it is dropped
 * once the part plays live. A linked clip that held a render keeps it until
 * EDIT's render upkeep brings it up to date: a render kept on purpose is
 * re-rendered, one made only so the part could be heard is re-rendered while
 * the part still cannot play live and dropped once it can.
 *
 * The roll's named markers go with the send: onto the clip (`sourceMarkers`)
 * and onto EDIT's timeline, each at the second its step sounds in the clip's
 * window, as markers whose ids name the clip (lib/rollMarkers). The clip write
 * and the marker write are one EDIT undo step, and a second send of the same
 * clip replaces its markers there instead of adding more.
 *
 * When the roll's tempo map or meter map differs from the arrangement's, the
 * send offers them to EDIT (editorStore offerClipTimeMaps); the arrangement
 * changes only when the offer is accepted.
 */
import { useEditorStore } from '../state/editorStore';
import { usePianoRollStore } from '../state/pianoRollStore';
import { requestMidiRender } from '../state/midiRenderQueue';
import { logError } from '../state/logStore';
import { rollVoice, type GlobalVoice } from './clipProgram';
import { midiClipNominalSec, midiLiveWindowFields } from './midiRender';
import { showsWholeSource } from './clipRenderWindow';
import { MIN_CLIP_SEC } from './clipDragMath';
import { rollClipFields } from './rollClip';
import { clipTimelineMarkers } from './rollMarkers';

export interface RollBounceDeps {
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
}

export interface RollBounceResult {
  /** `updated` wrote the linked clip; `created` added a clip on a new track. */
  kind: 'updated' | 'created';
  clipId: string;
  /** The clip's length: its whole grid under its tempo map. */
  duration: number;
  noteCount: number;
  /** True when the part cannot play live and its render was queued. */
  rendering: boolean;
}

/**
 * Send the roll to EDIT. Resolves null when the roll has no notes. A part with
 * no program resolves once its queued render lands; a render that fails is
 * logged and the notes stay on the clip (EDIT's render upkeep tries again).
 */
export async function bounceRollToEditor(deps: RollBounceDeps): Promise<RollBounceResult | null> {
  const roll = usePianoRollStore.getState();
  const { bpm, editingClipId } = roll;
  if (roll.notes.length === 0) return null;
  // The editor plays a clip's notes once, so it gets the lane repeats written
  // out (sourcePianoRoll). The roll's own notes, meter map, pickup, lanes and
  // bends are copied beside them, so re-editing later sees the exact same state.
  const fields = rollClipFields(roll);
  const noteCount = fields.sourcePianoRoll.length;
  const before = useEditorStore.getState();
  const voice = rollVoice(editingClipId, before.clips, before.tracks, deps.global(), roll.voiceProgram);
  // The bpm in labels and names, to the hundredth (a detected 97.333… reads 97.33).
  const bpmText = String(Math.round(bpm * 100) / 100);
  const label = `roll_${bpmText}bpm_${noteCount}n`;
  // The whole grid under the roll's tempo map: the window a clip with no render has.
  const nominal = midiClipNominalSec(fields, bpm);

  /** The roll's markers on EDIT's timeline, at their seconds in the clip's window at `startSec`. */
  const markClip = (id: string, startSec: number, window: { offsetIntoSource: number; durationSec: number }): void =>
    useEditorStore.getState().setClipRollMarkers(
      id,
      clipTimelineMarkers(roll.markers, {
        clipId: id,
        startSec,
        offsetSec: window.offsetIntoSource,
        durationSec: window.durationSec,
        bpm,
        tempoMap: fields.sourceTempoMap,
      }),
    );
  const wholeGrid = { offsetIntoSource: 0, sourceDuration: nominal, durationSec: nominal };

  let clipId: string;
  let kind: RollBounceResult['kind'];
  const linked = editingClipId ? before.clips.find((c) => c.id === editingClipId) : undefined;
  if (linked) {
    // A part showing its whole source takes the whole new grid. A part the user
    // trimmed or split keeps its window (a trim past the new grid's end falls
    // back to the whole grid). A render the clip holds is left for EDIT's render
    // upkeep (lib/midiRender marks it stale against the new notes).
    const kept = showsWholeSource(linked) ? null : midiLiveWindowFields(linked, nominal);
    const keptSec = kept ? kept.durationSec ?? linked.durationSec : 0;
    const window = kept && keptSec >= MIN_CLIP_SEC
      ? { offsetIntoSource: linked.offsetIntoSource ?? 0, sourceDuration: nominal, durationSec: keptSec }
      : wholeGrid;
    before.undoGroup(() => {
      before.updateClip(linked.id, {
        ...fields,
        sourceKind: 'piano-roll',
        ...window,
        label: linked.label.startsWith('roll_') ? label : linked.label,
      });
      markClip(linked.id, linked.startSec, window);
    });
    clipId = linked.id;
    kind = 'updated';
  } else {
    // The clip the roll was bound to is gone, or there never was one: a new
    // track holds the voice (the roll's own or the picker's, as rollVoice found).
    if (editingClipId) usePianoRollStore.getState().setEditingClip(null);
    const editor = useEditorStore.getState();
    clipId = editor.undoGroup(() => {
      const trackId = editor.addTrack({ name: `Piano ${bpmText} BPM`, instrumentProgram: voice.program });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const id = editor.addClipToTrack({
        trackId,
        label,
        mimeType: 'audio/wav',
        sourceDuration: nominal,
        offsetIntoSource: 0,
        durationSec: nominal,
        startSec: 0,
        color: trackColor,
        sourceKind: 'piano-roll',
        ...fields,
      });
      markClip(id, useEditorStore.getState().clips.find((c) => c.id === id)?.startSec ?? 0, wholeGrid);
      return id;
    });
    // Bind the roll to the new clip so subsequent Send-to-Editor edits in place.
    usePianoRollStore.getState().setEditingClip(clipId);
    kind = 'created';
  }
  // The roll's tempo and meter, offered to the arrangement when they differ from
  // it (EDIT shows the offer above the timeline; nothing changes until accepted).
  useEditorStore.getState().offerClipTimeMaps(clipId);

  // A part with no program cannot play live: queue its render so it can be heard.
  const rendering = voice.program === undefined;
  if (rendering) {
    try {
      await requestMidiRender(clipId, 'cache');
    } catch (e) {
      logError('piano-roll', `The part is in EDIT, but its render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const now = useEditorStore.getState().clips.find((c) => c.id === clipId);
  return { kind, clipId, duration: now?.durationSec ?? nominal, noteCount, rendering };
}
