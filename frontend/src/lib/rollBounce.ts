/**
 * rollBounce — the piano roll's EDIT key: put the roll's parts on the EDIT
 * timeline, one MIDI clip per part.
 *
 * Every part with notes plays through its own voice (lib/rollTracks
 * partVoice: its own program, else its linked clip's, else the roll's own or
 * the picker's), in its own Bank, as the roll plays it live (lib/rollPartVoice).
 * A part linked to an EDIT clip writes that clip in place, and a part with a
 * program of its own writes it onto the clip, with the bank it is chosen in
 * (`instrumentBank`), so EDIT plays what the roll played. A part with no clip,
 * or whose clip is gone, lands on a new EDIT track named and coloured after
 * the part, holding the part's program (a percussion part makes a drum track),
 * so changing the picker later does not re-voice it; the part is then linked
 * to its new clip. A linked part that became a drum part (or stopped being
 * one) since its clip was made moves its clip onto a track of its kind: its
 * own track turns into one when the clip is alone there, otherwise the clip
 * goes to a new track beside it, so EDIT never plays drums through a melodic
 * program. Each clip records the part it holds (`sourceRollPart`), so opening
 * any one of the clips opens every part again (lib/rollClip clipPartsLoad).
 *
 * A clip's audio is an optional render (lib/midiRender), and the EDIT key
 * renders nothing itself. It writes the notes, the document's meter map,
 * pickup, lanes, bends and tempo map (every part's clip carries the same
 * ones). A new part, and a linked part that shows its whole source, take the
 * whole grid as their window; a linked part the user trimmed or split in EDIT
 * keeps its window, shortened only where the new grid ends first
 * (lib/midiRender midiLiveWindowFields), so a split half sent back from the
 * roll stays that half and never covers its neighbour. A part with a program
 * plays live on EDIT's synths and renders when an export needs it, so a
 * 24-part score holds no audio. A part with no program cannot play live: its
 * render is queued (state/midiRenderQueue, one render at a time) and marked
 * as made so it can be heard, so it is dropped once the part plays live. A
 * linked clip that held a render keeps it until EDIT's render upkeep brings it
 * up to date.
 *
 * A part that plays through a VST3 instrument (RollTrack `vstInstrument`)
 * takes it to its EDIT track: the track's instrument slot gets a copy of the
 * plugin with the state its editor captured (the slot's own entry kept when
 * it already holds that plugin, so its running session is reused), on or off
 * as the part has it, with the part's articulation switch. EDIT then plays the
 * clip through the plugin live and prints it through POST /api/vst/render-midi
 * in every bounce, freeze and export (lib/renderCore printInstrumentTracks),
 * and no render is queued for it. The part's program stays on the clip and
 * the track, the voice EDIT falls back to and a MIDI export writes. A part
 * whose plugin was taken away since its last send takes the plugin it put on
 * the track away again.
 *
 * The roll's named markers go with the send: onto every part's clip
 * (`sourceMarkers`, so any of them reopens them) and once onto EDIT's
 * timeline, written by the first part with notes, each at the second its step
 * sounds in that clip's window, as markers whose ids name the clip
 * (lib/rollMarkers). The other parts' clips hold none there, so a 24-part
 * score shows each marker once, and a second send replaces them instead of
 * adding more. Every clip write and the marker write are one EDIT undo step.
 *
 * When the roll's tempo map or meter map differs from the arrangement's, the
 * send offers them to EDIT (editorStore offerClipTimeMaps); the arrangement
 * changes only when the offer is accepted.
 */
import { useEditorStore, type AudioClip } from '../state/editorStore';
import { partLinkOf, rollTracksOf, usePianoRollStore, type RollPartRef, type RollTrack } from '../state/pianoRollStore';
import { requestMidiRender } from '../state/midiRenderQueue';
import { logError } from '../state/logStore';
import { isPercussionTrack, type ClipVoice, type GlobalVoice } from './clipProgram';
import { midiClipNominalSec, midiLiveWindowFields } from './midiRender';
import { showsWholeSource } from './clipRenderWindow';
import { MIN_CLIP_SEC } from './clipDragMath';
import { rollClipFields, rollPartRef } from './rollClip';
import { clipTimelineMarkers } from './rollMarkers';
import { isDefaultPartName, isPercussionPart, partClipSound, partVoice } from './rollTracks';
import type { ChainEntry } from '../state/effectChainStore';
import type { EditorTrack } from '../state/editorStore';

/** A new id for an EDIT instrument slot entry copied from a part: a session of its own. */
const slotUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `inst-${crypto.randomUUID()}` : `inst-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * The instrument slot and articulation switch a part's send gives its EDIT
 * track `track` (undefined: a new track), or null to leave the track's as they
 * are. `before` is the part's record on its clip from the last send.
 */
export function partTrackInstrument(
  part: Pick<RollTrack, 'vstInstrument' | 'articulationSwitch'>,
  track: Pick<EditorTrack, 'instrument'> | undefined,
  before: Pick<RollPartRef, 'vstInstrument'> | undefined,
): Pick<EditorTrack, 'instrument' | 'articulationSwitch'> | null {
  const vst = part.vstInstrument?.vst;
  if (vst) {
    const own = track?.instrument?.vst?.plugin_path === vst.plugin_path ? track.instrument : undefined;
    const instrument: ChainEntry = {
      id: own?.id ?? slotUid(),
      effect: 'vst3',
      params: { ...(part.vstInstrument as ChainEntry).params },
      enabled: (part.vstInstrument as ChainEntry).enabled,
      vst: { ...vst },
    };
    return { instrument, articulationSwitch: part.articulationSwitch };
  }
  // The plugin a part put on its track last time goes when the part has none now; one the user put there stays.
  const put = before?.vstInstrument?.vst?.plugin_path;
  if (put && track?.instrument?.vst?.plugin_path === put) return { instrument: undefined, articulationSwitch: undefined };
  return null;
}

export interface RollBounceDeps {
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
  /** Told as each part lands on EDIT's timeline, with how many are done of how many. */
  onPart?: (done: number, of: number, part: RollTrack) => void;
}

/** One part's send: its clip, whether that clip was written in place or made, and whether its render was queued. */
export interface RollPartBounce {
  partId: string;
  kind: 'updated' | 'created';
  clipId: string;
  /** The clip's length on the timeline. */
  duration: number;
  noteCount: number;
  /** True when the part cannot play live and its render was queued. */
  rendering: boolean;
}

export interface RollBounceResult {
  /** `updated` when every part wrote its linked clip; `created` when any part made a new clip. */
  kind: 'updated' | 'created';
  /** The active part's clip (the first sent part's when the active part has no notes). */
  clipId: string;
  /** The longest part's seconds. */
  duration: number;
  /** Every part's notes as they sound. */
  noteCount: number;
  /** True when any part cannot play live and its render was queued. */
  rendering: boolean;
  parts: RollPartBounce[];
}

/**
 * The track a linked part's clip belongs on: its own, when the track's kind
 * (drum or melodic) is the part's. A part with a sound of its own (a program,
 * or channel 10) switched to a kit or back since the clip was made needs the
 * other kind: the clip's track turns into it when the clip is alone there
 * (keeping its mixer and effects), holding the voice the part plays with;
 * with other clips on it, a new track of the part's kind, named and coloured
 * after the part, takes the clip, right below the old one, so the other clips
 * keep their voice. A part that follows the roll voice plays its clip's voice,
 * drums on a drum track included (lib/rollTracks partVoice), so its clip stays.
 */
function trackOfItsKind(clip: AudioClip, part: RollTrack, voice: ClipVoice): string {
  const editor = useEditorStore.getState();
  const track = editor.tracks.find((t) => t.id === clip.trackId);
  const drums = isPercussionPart(part);
  if (!drums && part.program === null) return clip.trackId;
  if (!track || isPercussionTrack(track) === drums) return clip.trackId;
  const alone = !editor.clips.some((c) => c.trackId === track.id && c.id !== clip.id);
  if (alone) {
    editor.updateTrack(track.id, { isPercussion: drums ? true : undefined, instrumentProgram: voice.program });
    return track.id;
  }
  return editor.insertTrack(editor.tracks.indexOf(track) + 1, {
    name: part.name,
    instrumentProgram: voice.program,
    ...(drums ? { isPercussion: true } : {}),
    color: part.color,
    nameAutoGenerated: false,
  });
}

/**
 * Send the roll to EDIT, every part with notes. Resolves null when no part has
 * notes. Parts with no program resolve once their queued renders land; a
 * render that fails is logged and the notes stay on the clip (EDIT's render
 * upkeep tries again).
 */
export async function bounceRollToEditor(deps: RollBounceDeps): Promise<RollBounceResult | null> {
  const roll = usePianoRollStore.getState();
  const { bpm } = roll;
  const all = rollTracksOf(roll);
  const parts = all.filter((t) => t.notes.length > 0);
  if (parts.length === 0) return null;
  const doc = roll.rollDocId;
  const one = all.length === 1;
  // The tempo in labels and names, to the hundredth (a detected 97.333… reads 97.33).
  const bpmText = String(Math.round(bpm * 100) / 100);
  const out: RollPartBounce[] = [];
  const unvoiced: string[] = [];

  useEditorStore.getState().undoGroup(() => {
    for (const part of parts) {
      const order = all.indexOf(part);
      // The editor plays a clip's notes once, so it gets the lane repeats written
      // out (sourcePianoRoll). The part's own notes, the document's meter map,
      // pickup, lanes, bends, tempo map and markers, and the part's record are
      // copied beside them, so re-editing later sees the exact same state.
      const fields = { ...rollClipFields({ ...roll, notes: part.notes }), sourceRollPart: rollPartRef(part, order, doc) };
      const noteCount = fields.sourcePianoRoll.length;
      const before = useEditorStore.getState();
      const link = partLinkOf(usePianoRollStore.getState(), part.id);
      const partSound = partVoice(part, link, before.clips, before.tracks, deps.global(), roll.voiceProgram);
      // The part's own sound on its clip (lib/rollTracks partClipSound): its program,
      // and the bank the roll plays that program in (lib/rollPartVoice), none on the
      // drum channel, where the kit is chosen by program, and none without a program.
      // A bank belongs to a program (lib/clipProgram clipBank), so a part in a bank
      // past 0 with no program of its own pins the program the roll played it with;
      // bank 0 clears a bank an earlier send wrote.
      const sound = partClipSound(part, partSound);
      const bank = sound.bank;
      const voice: ClipVoice = { program: partSound.program, percussion: partSound.percussion, ...(bank > 0 ? { bank } : {}) };
      const ownSound: Partial<AudioClip> = {
        ...(sound.program !== undefined ? { instrumentProgram: sound.program } : {}),
        instrumentBank: bank > 0 ? bank : undefined,
      };
      const label = `roll_${bpmText}bpm_${noteCount}n`;
      // The whole grid under the document's tempo map: the window a clip with no render has.
      const nominal = midiClipNominalSec(fields, bpm);
      const wholeGrid = { offsetIntoSource: 0, sourceDuration: nominal, durationSec: nominal };
      const existing = link ? before.clips.find((c) => c.id === link) : undefined;
      let clipId: string;
      if (existing) {
        // A part showing its whole source takes the whole new grid. A part the user
        // trimmed or split keeps its window (a trim past the new grid's end falls
        // back to the whole grid). A render the clip holds is left for EDIT's render
        // upkeep (lib/midiRender marks it stale against the new notes).
        const kept = showsWholeSource(existing) ? null : midiLiveWindowFields(existing, nominal);
        const keptSec = kept ? kept.durationSec ?? existing.durationSec : 0;
        const window = kept && keptSec >= MIN_CLIP_SEC
          ? { offsetIntoSource: existing.offsetIntoSource ?? 0, sourceDuration: nominal, durationSec: keptSec }
          : wholeGrid;
        const trackId = trackOfItsKind(existing, part, voice);
        // The part's VST3 instrument onto its track's instrument slot.
        const slot = partTrackInstrument(part, useEditorStore.getState().tracks.find((t) => t.id === trackId), existing.sourceRollPart);
        if (slot) useEditorStore.getState().updateTrack(trackId, slot);
        useEditorStore.getState().updateClip(existing.id, {
          ...(trackId !== existing.trackId ? { trackId } : {}),
          ...fields,
          // A part with a program of its own puts it on its clip, over its track's, with its bank.
          ...ownSound,
          sourceKind: 'piano-roll',
          ...window,
          label: existing.label.startsWith('roll_') ? label : existing.label,
        });
        clipId = existing.id;
        out.push({ partId: part.id, kind: 'updated', clipId, duration: window.durationSec, noteCount, rendering: false });
      } else {
        // No clip, or the one the part was bound to is gone: a new track holds the
        // part's voice (its own, the roll's or the picker's, as partVoice found).
        // A roll of one part with its default name keeps the name and colour the
        // roll has always given its track.
        const editor = useEditorStore.getState();
        const plain = one && isDefaultPartName(part.name);
        const trackId = editor.addTrack({
          name: plain ? `Piano ${bpmText} BPM` : part.name,
          instrumentProgram: voice.program,
          ...(isPercussionPart(part) ? { isPercussion: true } : {}),
          // A part's name is the track's, never replaced by the clip's label as an automatic name is.
          ...(plain ? {} : { color: part.color, nameAutoGenerated: false }),
          ...(part.mute ? { mute: true } : {}),
          // The part's VST3 instrument in the new track's instrument slot.
          ...(partTrackInstrument(part, undefined, undefined) ?? {}),
        });
        const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? part.color;
        clipId = editor.addClipToTrack({
          trackId,
          label,
          mimeType: 'audio/wav',
          ...wholeGrid,
          startSec: 0,
          color: trackColor,
          sourceKind: 'piano-roll',
          ...fields,
          // A bank past 0 rides on the clip with the program it is chosen in.
          ...(bank > 0 ? ownSound : {}),
        });
        // Bind the part to its new clip so the next send writes it in place.
        usePianoRollStore.getState().bindPartClip(part.id, clipId);
        out.push({ partId: part.id, kind: 'created', clipId, duration: nominal, noteCount, rendering: false });
      }
      // A part with no program cannot play live: its render is queued below, after every part is on the
      // timeline. A part that plays through a VST3 instrument plays live through it on its track.
      if (voice.program === undefined && !part.vstInstrument?.enabled) unvoiced.push(clipId);
      deps.onPart?.(out.length, parts.length, part);
    }

    // The document's markers on EDIT's timeline, once: the first part's clip
    // writes them at their seconds in its window, and the other parts' clips
    // hold none there, so a part list that changed order since the last send
    // leaves no second copy behind.
    const editor = useEditorStore.getState();
    const [anchor, ...rest] = out;
    const clip = editor.clips.find((c) => c.id === anchor.clipId);
    if (clip) {
      editor.setClipRollMarkers(
        clip.id,
        clipTimelineMarkers(roll.markers, {
          clipId: clip.id,
          startSec: clip.startSec,
          offsetSec: clip.offsetIntoSource ?? 0,
          durationSec: clip.durationSec,
          bpm,
          tempoMap: clip.sourceTempoMap,
        }),
      );
    }
    for (const p of rest) editor.setClipRollMarkers(p.clipId, []);
  });

  const active = out.find((p) => p.partId === roll.activeTrackId) ?? out[0];
  // The roll's tempo and meter, offered to the arrangement when they differ from
  // it (EDIT shows the offer above the timeline; nothing changes until accepted).
  useEditorStore.getState().offerClipTimeMaps(active.clipId);

  // Parts with no program cannot play live: queue their renders so they can be
  // heard. The queue renders one at a time; every request is awaited here so
  // the send resolves once each part can be heard.
  const renders = unvoiced.map(async (clipId) => {
    const p = out.find((x) => x.clipId === clipId) as RollPartBounce;
    p.rendering = true;
    try {
      await requestMidiRender(clipId, 'cache');
    } catch (e) {
      logError('piano-roll', `The part is in EDIT, but its render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  await Promise.all(renders);
  // A landed render may give a clip that shows its whole source the render's length (its ring-out).
  const clips = useEditorStore.getState().clips;
  for (const p of out) p.duration = clips.find((c) => c.id === p.clipId)?.durationSec ?? p.duration;
  return {
    kind: out.some((p) => p.kind === 'created') ? 'created' : 'updated',
    clipId: active.clipId,
    duration: out.reduce((m, p) => Math.max(m, p.duration), 0),
    noteCount: out.reduce((n, p) => n + p.noteCount, 0),
    rendering: out.some((p) => p.rendering),
    parts: out,
  };
}
