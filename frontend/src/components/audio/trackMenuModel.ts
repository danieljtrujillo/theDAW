/**
 * The footer track menu, as data: every thing the app can do to the track the
 * footer has loaded, grouped by job, each row enabled or carrying the reason it
 * is off, plus how the groups pack into the card's columns. Pure: no React, no
 * DOM, no stores (the type imports are erased), so the tsx test runs it under
 * plain node, the same shape as addToTrackMenu.ts.
 *
 * The footer track is one of four kinds:
 *   none     nothing is loaded.
 *   library  the player's entry id names a library entry.
 *   editor   the EDIT timeline ('editor-timeline'). It is never a library entry;
 *            it has readable bytes only when something loaded a render.
 *   loose    anything else with a label: a stem or MIDI row, the MIX source or
 *            output, the MIDI beat. Its bytes come from the player's object URL.
 *
 * Facts the backend knows (stems, MIDI, the lyrics document, the vocal melody,
 * a running separation, the file path) arrive as a Probe after the menu opens.
 * A row that needs one is off with "Checking" until it lands, so a click can
 * never race the answer.
 */
import type { CenterTab } from '../../state/appUiStore';
import type { BottomPanelTab } from '../../state/bottomPanelStore';

export const EDITOR_TIMELINE_ID = 'editor-timeline';

export type TrackMenuSubjectKind = 'none' | 'library' | 'editor' | 'loose';

/** Which kind of track the footer holds. `entryFound` is whether the player's
 *  entry id is in the library list right now. */
export function trackMenuSubjectKind(
  player: { hasTrack: boolean; entryId: string | null },
  entryFound: boolean,
): TrackMenuSubjectKind {
  if (!player.hasTrack) return 'none';
  if (player.entryId === EDITOR_TIMELINE_ID) return 'editor';
  if (player.entryId && entryFound) return 'library';
  return 'loose';
}

/** A fact read from the backend when the menu opened. */
export type Probe<T> =
  | { state: 'checking' }
  | { state: 'known'; value: T }
  | { state: 'failed'; detail?: string };

export const probeChecking = <T>(): Probe<T> => ({ state: 'checking' });
export const probeKnown = <T>(value: T): Probe<T> => ({ state: 'known', value });
export const probeFailed = <T>(detail?: string): Probe<T> => ({ state: 'failed', detail });

/** The library record's fields the menu reads. */
export interface TrackMenuEntry {
  id: string;
  title: string;
  /** 'score' is a composition (a score with no recording): like a video or
   *  an image, every audio action is gated off it (REASON.notAudio). */
  kind: 'audio' | 'video' | 'image' | 'score';
  model: string;
  prompt: string;
  /** deriveStyle(entry), trimmed. */
  style: string;
  /** deriveLyrics(entry), trimmed: the lyrics field, else lyrics: tags, the
   *  analysis or the notes. */
  lyrics: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  /** The background analyzer has stored BPM / key for it. */
  analyzed: boolean;
}

export interface TrackMenuFormat {
  id: string;
  label: string;
}

/** One separated stem of the entry. */
export interface TrackMenuStem {
  id: string;
  name: string;
  /** The stored file's extension, without the dot. */
  ext: string;
}

/** The lyrics document the backend serves for the entry: the saved one, else
 *  the one it derives from the lyrics field, the file's embedded lyrics or
 *  lyrics: tags. Aligning, the rhyme analysis and the .txt export read it. */
export interface TrackMenuLyricsDoc {
  text: string;
  /** At least one lyric line has a start time. */
  timed: boolean;
}

export interface TrackMenuRunningJob {
  /** A stem separation is in flight for the entry. */
  stems: boolean;
  /** A vocal melody job this menu started for the entry that has not ended. */
  vocalJobId: string | null;
}

export interface TrackMenuFacts {
  kind: TrackMenuSubjectKind;
  /** The footer's label for the track ('' when none). */
  label: string;
  entry: TrackMenuEntry | null;
  /** Bytes of the loaded track can be read now. A library entry always can. */
  hasBytes: boolean;
  /** The entry's separated stems. */
  stems: Probe<TrackMenuStem[]>;
  /** The whole-mix MIDI row `<id>__full` exists. */
  wholeMidi: Probe<boolean>;
  /** Notation artifacts of the entry, by kind. */
  notation: Probe<{ midi: number; score: number }>;
  lyricsDoc: Probe<TrackMenuLyricsDoc>;
  /** A vocal melody artifact (the notes Vocal melody extracts) is stored. */
  vocalNotes: Probe<boolean>;
  /** A meter map is stored. */
  rhythmReady: Probe<boolean>;
  /** The audio file's absolute path; null when it is not on this disk. */
  audioPath: Probe<string | null>;
  /** The audio targets FFmpeg can convert to. */
  convertFormats: Probe<TrackMenuFormat[]>;
  /** What a Stop row could stop. */
  runningJob: Probe<TrackMenuRunningJob>;
  /** This window runs on the backend's machine (it can open its folders). */
  localClient: boolean;
  clipboard: boolean;
  inCrate: boolean;
  inDjNext: boolean;
  /** Index of the first empty DJ sampler pad, or null when all are taken. */
  freeSamplerPad: number | null;
  activeSet: { id: string; name: string } | null;
}

export type TrackMenuIcon =
  | 'list-music' | 'sparkles' | 'square-plus' | 'arrow-right-to-line' | 'layers' | 'sliders-horizontal'
  | 'dna' | 'grid-3x3' | 'workflow' | 'git-fork' | 'waves' | 'cast' | 'info' | 'music' | 'mic-vocal'
  | 'book-open' | 'pen-line' | 'audio-lines' | 'brush' | 'gauge' | 'activity' | 'audio-waveform' | 'eraser'
  | 'combine' | 'text-cursor-input' | 'disc-3' | 'file-music' | 'piano' | 'grid-2x2' | 'drum' | 'scan-line'
  | 'scan-search' | 'split' | 'timer' | 'scissors' | 'captions' | 'align-left' | 'quote' | 'mic' | 'guitar'
  | 'swords' | 'image' | 'disc' | 'list-plus' | 'list-end' | 'shuffle' | 'download' | 'package'
  | 'file-json' | 'network' | 'file-text' | 'file-audio' | 'folder-open' | 'clipboard-copy' | 'link' | 'type'
  | 'message-square-text' | 'palette' | 'scroll-text' | 'inbox' | 'library' | 'star' | 'thumbs-up'
  | 'thumbs-down' | 'tag' | 'library-big' | 'trash-2' | 'file-up' | 'circle-stop';

export type TrackMenuDestination =
  | { area: 'center'; tab: CenterTab }
  | { area: 'dock'; tab: BottomPanelTab }
  | { area: 'library' };

export interface TrackMenuRow {
  id: string;
  /** The row's text; for a key in a line, its spoken and type-ahead name. */
  label: string;
  icon: TrackMenuIcon;
  enabled: boolean;
  /** What choosing it does. */
  does: string;
  /** Why it is off right now; null when enabled. */
  reason: string | null;
  /** The tooltip: the reason when off, else what it does. */
  title: string;
  /** It starts a backend job that can run for a while. */
  longJob: boolean;
  /** The tab it switches to, if any. */
  goes: TrackMenuDestination | null;
  danger: boolean;
  /** Drawn as a short key in a wrapping row (the convert formats). */
  chip: boolean;
  /** Drawn as an icon key in a line of keys that share `key`, with `label` at
   *  the line's start (one line per stem). */
  line: { key: string; label: string } | null;
}

export type TrackMenuGroupId =
  | 'play' | 'open' | 'dock' | 'make' | 'midi' | 'analyze' | 'dj' | 'save' | 'convert' | 'copy' | 'library' | 'stems';

export interface TrackMenuGroup {
  id: TrackMenuGroupId;
  label: string;
  rows: TrackMenuRow[];
  /** Every row in the group starts a backend job; the heading says so once. */
  longJob: boolean;
}

/* ── reasons ───────────────────────────────────────────────────────────── */

export const REASON = {
  noTrack: 'Load a track into the footer first',
  editorNotEntry: 'The EDIT timeline is not a library entry. Mix it down to the library in EDIT first',
  looseNotEntry: 'This track is not a library entry. Use Save to the library first',
  notAudio: 'This library entry is not audio',
  editorLive: 'The EDIT timeline plays live, so there is no rendered audio to hand over. Mix it down in EDIT first',
  noBytes: 'The footer holds no readable audio for this track',
  checking: 'Checking this track',
  probeFailed: 'The backend did not answer the check for this',
  noStems: 'No stems yet. Run Separate stems first',
  noMidi: 'No MIDI yet. Run Convert to MIDI first',
  noScore: 'No sheet music yet. Run Sheet music first',
  noLyrics: 'No lyrics on this entry yet. Transcribe them, or type them in SING',
  noTimedLyrics: 'No timed lyrics yet. Transcribe or align them first',
  noVocalNotes: 'No vocal melody yet. Run Vocal melody first',
  notAnalyzed: 'Not analyzed yet. Run BPM, key and pitch first',
  noRhythm: 'No meter map yet. Run Meter and rhythm map first',
  noRunningJob: 'No stem separation or vocal melody job is running for it',
  notSuno: 'Only a Suno track carries the Suno clip id this needs',
  noPath: 'The audio file is not on this disk',
  pathRouteMissing: 'The running backend cannot report file paths yet. Restart the backend to add that route',
  notLocal: 'Only the computer running the backend can open its folders',
  noClipboard: 'The clipboard is not available in this window',
  inCrate: 'Already in the LOOM crate',
  inDjNext: 'Already staged in DJ Next',
  noPad: 'All ten sampler pads are taken',
  noSet: 'No active DJ set. Pick one in DJ first',
  alreadyInLibrary: 'Already in the library',
  noFormats: 'FFmpeg reports no audio formats',
  noPrompt: 'This entry has no prompt',
  noStyle: 'This entry has no style text',
  noLabel: 'This track has no title',
} as const;

/* ── gates: each returns the reason a row is off, or null ─────────────── */

type Gate = string | null;

const firstReason = (...gates: Array<() => Gate>): Gate => {
  for (const g of gates) {
    const r = g();
    if (r !== null) return r;
  }
  return null;
};

const probeGate = <T>(p: Probe<T>, check: (value: T) => Gate): Gate => {
  if (p.state === 'checking') return REASON.checking;
  if (p.state === 'failed') return p.detail || REASON.probeFailed;
  return check(p.value);
};

/** The DJ sampler numbers its tenth pad 0, like a keyboard row. */
export const samplerPadName = (index: number): string => String(index === 9 ? 0 : index + 1);

const SHORT_FORMAT: Record<string, string> = {
  wav: 'WAV',
  wav24: 'WAV 24',
  wav32f: 'WAV 32F',
  flac: 'FLAC',
  mp3: 'MP3',
  ogg: 'OGG',
  opus: 'OPUS',
  m4a: 'M4A',
  aiff: 'AIFF',
};

export const shortFormatLabel = (id: string): string => SHORT_FORMAT[id] ?? id.toUpperCase();

/* ── the menu ─────────────────────────────────────────────────────────── */

interface RowOpts {
  longJob?: boolean;
  goes?: TrackMenuDestination;
  danger?: boolean;
  chip?: boolean;
  line?: { key: string; label: string };
}

const makeRow = (
  id: string,
  label: string,
  icon: TrackMenuIcon,
  does: string,
  reason: Gate,
  opts: RowOpts = {},
): TrackMenuRow => ({
  id,
  label,
  icon,
  enabled: reason === null,
  does,
  reason,
  title: reason ?? does,
  longJob: !!opts.longJob,
  goes: opts.goes ?? null,
  danger: !!opts.danger,
  chip: !!opts.chip,
  line: opts.line ?? null,
});

const center = (tab: CenterTab): TrackMenuDestination => ({ area: 'center', tab });
const dock = (tab: BottomPanelTab): TrackMenuDestination => ({ area: 'dock', tab });

/** The keys each stem line offers, in order. */
const STEM_KEYS: Array<{
  action: string;
  icon: TrackMenuIcon;
  label: string;
  does: (name: string) => string;
  goes?: TrackMenuDestination;
}> = [
  { action: 'edit', icon: 'square-plus', label: 'new EDIT track', does: (n) => `Add the ${n} stem as a new EDIT track`, goes: center('edit') },
  { action: 'init', icon: 'audio-waveform', label: 'Init audio', does: (n) => `Load the ${n} stem into the generator init slot and switch init on`, goes: center('make') },
  { action: 'inpaint', icon: 'eraser', label: 'Inpaint audio', does: (n) => `Load the ${n} stem into the inpaint slot with an empty mask to set`, goes: center('make') },
  { action: 'chimera', icon: 'combine', label: 'Chimera stack', does: (n) => `Add the ${n} stem to the Chimera mashup stack`, goes: center('make') },
  { action: 'save', icon: 'download', label: 'save a copy', does: (n) => `Save the ${n} stem file where you choose` },
];

export const stemRowId = (action: string, stemId: string): string => `stem:${action}:${stemId}`;

/** The action and stem id of a stem key's row id, or null for any other row. */
export function parseStemRowId(id: string): { action: string; stemId: string } | null {
  if (!id.startsWith('stem:')) return null;
  const rest = id.slice('stem:'.length);
  const at = rest.indexOf(':');
  if (at <= 0 || at === rest.length - 1) return null;
  return { action: rest.slice(0, at), stemId: rest.slice(at + 1) };
}

export function buildTrackMenu(f: TrackMenuFacts): TrackMenuGroup[] {
  const e = f.entry;

  const track = (): Gate => (f.kind === 'none' ? REASON.noTrack : null);
  const entry = (): Gate =>
    f.kind === 'none'
      ? REASON.noTrack
      : f.kind === 'editor'
        ? REASON.editorNotEntry
        : f.kind === 'loose' || !e
          ? REASON.looseNotEntry
          : null;
  const audioEntry = (): Gate => entry() ?? (e && e.kind !== 'audio' ? REASON.notAudio : null);
  /** Audio bytes a destination can decode: a library audio entry, or the loaded bytes. */
  const bytes = (): Gate => {
    if (f.kind === 'none') return REASON.noTrack;
    if (f.kind === 'library') return e && e.kind !== 'audio' ? REASON.notAudio : null;
    if (f.hasBytes) return null;
    return f.kind === 'editor' ? REASON.editorLive : REASON.noBytes;
  };
  const analyzed = (): Gate => (e && !e.analyzed ? REASON.notAnalyzed : null);
  /** Words the backend reads for the entry (align, rhyme analysis, .txt export). */
  const backendWords = (): Gate => probeGate(f.lyricsDoc, (d) => (d.text.trim() ? null : REASON.noLyrics));
  /** Words the app can copy: the record's own lyrics text, else the backend's. */
  const anyWords = (): Gate => (e && e.lyrics ? null : backendWords());
  const stems = (): Gate => probeGate(f.stems, (list) => (list.length > 0 ? null : REASON.noStems));
  const wholeMidi = (): Gate => probeGate(f.wholeMidi, (has) => (has ? null : REASON.noMidi));
  const midiArtifact = (): Gate => probeGate(f.notation, (n) => (n.midi > 0 ? null : REASON.noMidi));
  const scoreArtifact = (): Gate => probeGate(f.notation, (n) => (n.score > 0 ? null : REASON.noScore));
  const anyNotation = (): Gate => probeGate(f.notation, (n) => (n.midi + n.score > 0 ? null : REASON.noMidi));
  const clipboard = (): Gate => (f.clipboard ? null : REASON.noClipboard);
  const path = (): Gate => probeGate(f.audioPath, (p) => (p ? null : REASON.noPath));

  const title = e?.title || f.label;

  const play: TrackMenuGroup = {
    id: 'play',
    label: 'Play',
    longJob: false,
    rows: [
      makeRow('play-library', 'Library from this track', 'list-music',
        'Play the library list in its current order from this track on, moving to the next at each end',
        firstReason(audioEntry)),
      makeRow('play-mix', 'Mix built from this track', 'sparkles',
        'Ask the playlist suggester for an hour that flows by key and BPM from this track, then play it',
        firstReason(audioEntry, analyzed)),
    ],
  };

  const open: TrackMenuGroup = {
    id: 'open',
    label: 'Open in',
    longJob: false,
    rows: [
      makeRow('edit-new-track', 'Own lane in EDIT', 'square-plus',
        'Put the clip at 0s on the first empty EDIT lane, adding a lane when every one is taken', firstReason(bytes), { goes: center('edit') }),
      makeRow('edit-append', 'End of EDIT lane 1', 'arrow-right-to-line',
        'Put the clip on the first empty EDIT lane, or after the last clip on lane 1 when every lane is taken', firstReason(bytes), { goes: center('edit') }),
      makeRow('edit-stems', 'Stems as EDIT tracks', 'layers',
        'Pick the stem count, device and quality, separate it, then add one EDIT track per stem',
        firstReason(audioEntry), { goes: center('edit'), longJob: true }),
      makeRow('mix-source', 'Source in MIX', 'sliders-horizontal',
        'Make it the MIX working file the rack processes', firstReason(bytes), { goes: center('mix') }),
      makeRow('morph-a', 'Metamorph donor A', 'dna',
        'Load it as the Metamorph donor (A) and show the Metamorph panel in EDIT',
        firstReason(bytes), { goes: center('edit') }),
      makeRow('morph-b', 'Metamorph host B', 'dna',
        'Load it as the Metamorph host (B) and show the Metamorph panel in EDIT',
        firstReason(bytes), { goes: center('edit') }),
      makeRow('loom-crate', 'Crate in LOOM', 'grid-3x3',
        'Put it on deck for LOOM, cutting its bar shards when it has none',
        firstReason(audioEntry, () => (f.inCrate ? REASON.inCrate : null)), { goes: center('loom'), longJob: true }),
      makeRow('nodefi-library', 'Library node in NodeF.I.', 'workflow',
        'Add a Library source node bound to it in the NodeF.I. graph', firstReason(audioEntry), { goes: center('nodefi') }),
      makeRow('nodefi-stems', 'Stem nodes in NodeF.I.', 'git-fork',
        'Add one Stem node per separated stem in the NodeF.I. graph',
        firstReason(audioEntry, stems), { goes: center('nodefi') }),
      makeRow('sway', 'Visualizer in SWAY', 'waves',
        'Open SWAY, which draws the master output while its audio source is theDAW', firstReason(track),
        { goes: center('sway') }),
      makeRow('vj-send', 'Send to the VJ set', 'cast',
        'Add it to the VJ performance set, where it waits until VJ opens, and analyze it on the way',
        firstReason(audioEntry)),
      makeRow('media-bucket', 'Add to the media bucket', 'inbox', 'Add the audio to the media bucket SLIDE and DETAILS use',
        firstReason(bytes)),
    ],
  };

  const dockGroup: TrackMenuGroup = {
    id: 'dock',
    label: 'Open in the dock',
    longJob: false,
    rows: [
      makeRow('dock-details', 'Details', 'info', 'Select it and show its record in DETAILS',
        firstReason(entry), { goes: dock('details') }),
      makeRow('dock-score', 'Score', 'music', 'Select it and list its notation in SCORE',
        firstReason(audioEntry), { goes: dock('score') }),
      makeRow('dock-sing', 'Sing along', 'mic-vocal', 'Select it and show its karaoke lyrics in SING',
        firstReason(audioEntry), { goes: dock('sing') }),
      makeRow('dock-study', 'Lyric study', 'book-open', 'Open SING on STUDY, the lyrics beside their analysis',
        firstReason(audioEntry), { goes: dock('sing') }),
      makeRow('dock-lyric', 'Lyric studio', 'pen-line', 'Open the LYRIC writing surface with this song as the attach target',
        firstReason(entry), { goes: dock('lyric') }),
      makeRow('dock-midi', 'Vocal2MIDI song box', 'audio-lines',
        'Put it in the Vocal2MIDI song box and open MIDI with the Vocal2MIDI column shown',
        firstReason(audioEntry), { goes: dock('midi') }),
      makeRow('dock-draw', 'Grains in DRAW', 'brush',
        'Select it and open DRAW. Pick the granular sound mode there to play its grains',
        firstReason(audioEntry), { goes: dock('draw') }),
      makeRow('dock-levels', 'Levels', 'gauge', 'Open LEVELS, the loudness and peak meters of the output',
        firstReason(track), { goes: dock('levels') }),
      makeRow('dock-spectral', 'Spectral', 'activity', 'Open SPECTRAL, the live spectrum of the output',
        firstReason(track), { goes: dock('spectral') }),
    ],
  };

  const make: TrackMenuGroup = {
    id: 'make',
    label: 'Use in MAKE',
    longJob: false,
    rows: [
      makeRow('make-init', 'Init audio', 'audio-waveform', 'Load it into the generator init slot and switch init on',
        firstReason(bytes), { goes: center('make') }),
      makeRow('make-inpaint', 'Inpaint audio', 'eraser', 'Load it into the inpaint slot with an empty mask to set',
        firstReason(bytes), { goes: center('make') }),
      makeRow('make-chimera', 'Chimera stack', 'combine', 'Add it to the Chimera mashup stack and analyze its BPM, key and beats',
        firstReason(bytes), { goes: center('make') }),
      makeRow('make-prompt', 'Its inferred prompt', 'text-cursor-input',
        'Write the prompt inferred from its analysis into the MAKE prompt field',
        firstReason(audioEntry, analyzed), { goes: center('make') }),
      makeRow('suno-cover', 'Suno cover', 'disc-3', 'Prefill the Suno Cover form with its clip id',
        firstReason(entry, () => (e && e.model !== 'suno' ? REASON.notSuno : null)), { goes: center('make') }),
      makeRow('suno-mashup', 'Suno mashup', 'disc-3', 'Prefill the Suno Mashup base clip with it',
        firstReason(entry, () => (e && e.model !== 'suno' ? REASON.notSuno : null)), { goes: center('make') }),
    ],
  };

  const midi: TrackMenuGroup = {
    id: 'midi',
    label: 'MIDI',
    longJob: false,
    rows: [
      makeRow('midi-convert', 'Convert to MIDI', 'file-music',
        'Transcribe the mix to MIDI, and its stems too when the MIDI from-stems setting is on',
        firstReason(audioEntry), { longJob: true }),
      makeRow('midi-roll', 'MIDI into the piano roll', 'piano',
        'Load its whole-mix MIDI into the piano roll in place of the roll\'s notes',
        firstReason(audioEntry, wholeMidi), { goes: dock('midi') }),
      makeRow('midi-step', 'MIDI into the step grid', 'grid-2x2',
        'Load its whole-mix MIDI into the step sequencer in place of its notes',
        firstReason(audioEntry, wholeMidi), { goes: dock('step-seq') }),
      makeRow('midi-groove', 'MIDI as the groove', 'drum', 'Learn the Virtuoso humanize groove from its MIDI timing and accents',
        firstReason(audioEntry, wholeMidi), { goes: dock('midi') }),
      makeRow('midi-detect', 'Notes from the audio', 'scan-line',
        'Detect notes in the audio with basic-pitch and put them in the piano roll in place of the roll\'s notes',
        firstReason(bytes), { goes: dock('midi'), longJob: true }),
      makeRow('melody-roll', 'Vocal notes into the roll', 'mic',
        'Load the notes of its vocal melody into the piano roll in place of the roll\'s notes',
        firstReason(audioEntry, () => probeGate(f.vocalNotes, (has) => (has ? null : REASON.noVocalNotes))),
        { goes: dock('midi') }),
      makeRow('synth-edit', 'Synth render in EDIT', 'square-plus',
        'Render its whole-mix MIDI with the synth and add the audio as a new EDIT track',
        firstReason(audioEntry, wholeMidi), { goes: center('edit') }),
      makeRow('synth-init', 'Synth render as Init', 'audio-waveform',
        'Render its whole-mix MIDI with the synth into the generator init slot',
        firstReason(audioEntry, wholeMidi), { goes: center('make') }),
      makeRow('synth-inpaint', 'Synth render as Inpaint', 'eraser',
        'Render its whole-mix MIDI with the synth into the inpaint slot',
        firstReason(audioEntry, wholeMidi), { goes: center('make') }),
      makeRow('synth-chimera', 'Synth render in Chimera', 'combine',
        'Render its whole-mix MIDI with the synth and add the audio to the Chimera stack',
        firstReason(audioEntry, wholeMidi), { goes: center('make') }),
    ],
  };

  const running = f.runningJob.state === 'known' ? f.runningJob.value : null;
  const stopDoes =
    running?.stems && running.vocalJobId
      ? 'Stop the stem separation and the vocal melody job running for it'
      : running?.vocalJobId
        ? 'Stop the vocal melody job running for it'
        : running?.stems
          ? 'Stop the stem separation running for it'
          : 'Stop a stem separation or vocal melody job running for it';

  const analyze: TrackMenuGroup = {
    id: 'analyze',
    label: 'Analyze and extract',
    longJob: false,
    rows: [
      makeRow('run-analysis', 'BPM, key and pitch', 'scan-search',
        'Analyze BPM, key, scale, loudness and beats', firstReason(audioEntry), { longJob: true }),
      makeRow('run-stems', 'Separate stems', 'split',
        'Pick the stem count, device and quality, then separate it into stems', firstReason(audioEntry), { longJob: true }),
      makeRow('run-rhythm', 'Meter and rhythm map', 'timer',
        'Build the meter map, tempo curve, syncopation and polymeter analysis', firstReason(audioEntry), { longJob: true }),
      makeRow('run-shards', 'LOOM shards', 'scissors', 'Cut it into tagged bar shards for LOOM',
        firstReason(audioEntry), { longJob: true }),
      makeRow('run-transcribe', 'Transcribe lyrics', 'captions', 'Transcribe the isolated vocal to timed lyrics',
        firstReason(audioEntry), { longJob: true }),
      makeRow('run-align', 'Align lyrics to audio', 'align-left', 'Align its lyric text to word timings',
        firstReason(audioEntry, backendWords), { longJob: true }),
      makeRow('run-devices', 'Rhyme and wordplay', 'quote', 'Find rhyme, assonance and double meanings in its lyrics',
        firstReason(entry, backendWords), { longJob: true }),
      makeRow('run-melody', 'Vocal melody', 'mic', 'Isolate the vocal and extract its melody for the SING pitch lane and the piano roll',
        firstReason(audioEntry), { longJob: true }),
      makeRow('run-chords', 'Chord track', 'guitar',
        'Build the chord track from the lead sheet, or estimate it from the audio, then show CHORDS in SCORE',
        firstReason(audioEntry), { goes: dock('score'), longJob: true }),
      makeRow('run-sheet', 'Sheet music', 'file-music', 'Convert its whole-mix MIDI to a MusicXML score',
        firstReason(audioEntry, wholeMidi), { goes: dock('score'), longJob: true }),
      makeRow('run-tabs', 'Guitar tab', 'guitar', 'Arrange standard-tuning guitar tab from its first MIDI artifact',
        firstReason(audioEntry, midiArtifact), { goes: dock('score'), longJob: true }),
      makeRow('run-arrange', 'Piano reduction', 'piano', 'Arrange a piano reduction from its first MIDI artifact',
        firstReason(audioEntry, midiArtifact), { goes: dock('score'), longJob: true }),
      makeRow('run-beatsaber', 'Beat Saber map', 'swords',
        'Export a Beat Saber pack (Normal and Hard, v2, with audio) from its score or MIDI',
        firstReason(audioEntry, anyNotation), { goes: dock('score'), longJob: true }),
      makeRow('stop-job', 'Stop its running job', 'circle-stop', stopDoes,
        firstReason(audioEntry, () =>
          probeGate(f.runningJob, (r) => (r.stems || r.vocalJobId ? null : REASON.noRunningJob)))),
    ],
  };

  const padName = f.freeSamplerPad === null ? null : samplerPadName(f.freeSamplerPad);
  const dj: TrackMenuGroup = {
    id: 'dj',
    label: 'DJ',
    longJob: false,
    rows: [
      makeRow('dj-deck-a', 'Deck A', 'disc', 'Load it onto DJ deck A', firstReason(audioEntry), { goes: center('dj') }),
      makeRow('dj-deck-b', 'Deck B', 'disc', 'Load it onto DJ deck B', firstReason(audioEntry), { goes: center('dj') }),
      makeRow('dj-next', 'DJ Next queue', 'list-plus', 'Stage it at the end of the DJ play-next queue',
        firstReason(audioEntry, () => (f.inDjNext ? REASON.inDjNext : null))),
      makeRow('dj-pad', padName ? `Sampler pad ${padName}` : 'Sampler pad', 'grid-3x3',
        padName ? `Load it as a one-shot on DJ sampler pad ${padName}` : 'Load it as a one-shot on a DJ sampler pad',
        firstReason(audioEntry, () => (padName ? null : REASON.noPad))),
      makeRow('dj-set', 'Append to the DJ set', 'list-end',
        f.activeSet ? `Append it to the active DJ set "${f.activeSet.name}" and analyze it` : 'Append it to the active DJ set',
        firstReason(audioEntry, () => (f.activeSet ? null : REASON.noSet))),
      makeRow('dj-automix', 'Automix from here', 'shuffle',
        'Build a set that flows by key and BPM from this track, open DJ and start automix',
        firstReason(audioEntry, analyzed), { goes: center('dj') }),
    ],
  };

  const save: TrackMenuGroup = {
    id: 'save',
    label: 'Save',
    longJob: false,
    rows: [
      makeRow('save-copy', 'Save a copy', 'download', 'Save the audio file where you choose', firstReason(bytes)),
      makeRow('save-bundle', 'Save bundle (.zip)', 'package', 'Save a zip of the audio, metadata, stems, MIDI and scores',
        firstReason(entry), { longJob: true }),
      makeRow('save-midi', 'Save MIDI (.mid)', 'file-music', 'Save its whole-mix MIDI file',
        firstReason(audioEntry, wholeMidi)),
      makeRow('save-metadata', 'Save metadata (.json)', 'file-json', 'Save the library record as JSON', firstReason(entry)),
      makeRow('save-lineage', 'Save lineage (.json)', 'network', 'Save its generation lineage graph as JSON',
        firstReason(entry)),
      makeRow('save-lrc', 'Save lyrics (.lrc)', 'captions', 'Save the timed lyrics as an LRC file',
        firstReason(audioEntry, () => probeGate(f.lyricsDoc, (d) => (d.timed ? null : REASON.noTimedLyrics)))),
      makeRow('save-txt', 'Save lyrics (.txt)', 'file-text', 'Save the lyrics as plain text',
        firstReason(entry, backendWords)),
      makeRow('save-score-pack', 'Save score pack (.zip)', 'package', 'Save MusicXML plus an engraved PDF as a zip',
        firstReason(audioEntry, scoreArtifact), { longJob: true }),
      makeRow('save-meter-map', 'Save meter map (.json)', 'file-json', 'Save the meter map, tempo curve and beats as JSON',
        firstReason(audioEntry, () => probeGate(f.rhythmReady, (ready) => (ready ? null : REASON.noRhythm)))),
      makeRow('save-spectrogram', 'Save mel spectrogram', 'image', 'Render its mel spectrogram and save the PNG',
        firstReason(bytes), { longJob: true }),
    ],
  };

  const convertRows: TrackMenuRow[] = (() => {
    const base = firstReason(bytes);
    const p = f.convertFormats;
    if (p.state !== 'known') {
      return [makeRow('convert-formats', 'Formats', 'file-audio', 'Convert it with FFmpeg and save the result',
        base ?? probeGate(p, () => null), { chip: true })];
    }
    if (p.value.length === 0) {
      return [makeRow('convert-formats', 'Formats', 'file-audio', 'Convert it with FFmpeg and save the result',
        base ?? REASON.noFormats, { chip: true })];
    }
    return p.value.map((fmt) =>
      makeRow(`convert:${fmt.id}`, shortFormatLabel(fmt.id), 'file-audio', `Convert it to ${fmt.label} and save it`,
        base, { chip: true }));
  })();
  const convert: TrackMenuGroup = { id: 'convert', label: 'Convert and save', longJob: true, rows: convertRows };

  const copy: TrackMenuGroup = {
    id: 'copy',
    label: 'Copy and show',
    longJob: false,
    rows: [
      makeRow('show-in-folder', 'Show in folder', 'folder-open', 'Open the folder that holds the audio file, with the file selected',
        firstReason(entry, () => (f.localClient ? null : REASON.notLocal), path)),
      makeRow('copy-path', 'Copy file path', 'clipboard-copy', 'Copy the absolute path of the audio file',
        firstReason(entry, clipboard, path)),
      makeRow('copy-link', 'Copy stream link', 'link', 'Copy the backend link that streams the audio',
        firstReason(entry, clipboard)),
      makeRow('copy-title', 'Copy title', 'type', 'Copy the track title',
        firstReason(track, clipboard, () => (title ? null : REASON.noLabel))),
      makeRow('copy-prompt', 'Copy prompt', 'message-square-text', 'Copy the prompt it was made from',
        firstReason(entry, clipboard, () => (e && !e.prompt ? REASON.noPrompt : null))),
      makeRow('copy-style', 'Copy style', 'palette', 'Copy its style text',
        firstReason(entry, clipboard, () => (e && !e.style ? REASON.noStyle : null))),
      makeRow('copy-lyrics', 'Copy lyrics', 'scroll-text', 'Copy its lyrics', firstReason(entry, clipboard, anyWords)),
    ],
  };

  const starring = !e?.favorite;
  const library: TrackMenuGroup = {
    id: 'library',
    label: 'Library',
    longJob: false,
    rows: [
      makeRow('show-in-library', 'Show in the library', 'library', 'Open the library rail on its row and show DETAILS',
        firstReason(entry), { goes: { area: 'library' } }),
      makeRow('lineage-graph', 'Lineage graph', 'network', 'Show the graph of what it was made from and what came of it',
        firstReason(entry)),
      makeRow('favorite', starring ? 'Add to favorites' : 'Remove from favorites', 'star',
        starring ? 'Star it. Starring queues stems, lyrics, MIDI and a score for it' : 'Take the star off it',
        firstReason(entry), { longJob: starring }),
      makeRow('like', e?.rating === 'like' ? 'Remove the like' : 'Like', 'thumbs-up',
        e?.rating === 'like' ? 'Clear its like' : 'Rate it a like', firstReason(entry)),
      makeRow('dislike', e?.rating === 'dislike' ? 'Remove the dislike' : 'Dislike', 'thumbs-down',
        e?.rating === 'dislike' ? 'Clear its dislike' : 'Rate it a dislike', firstReason(entry)),
      makeRow('edit-meta', 'Title, tags and notes', 'tag', 'Edit its title, tags and notes', firstReason(entry)),
      makeRow('load-lyrics', 'Load lyrics (.lrc / .txt)', 'file-up',
        'Load its lyrics from an LRC or text file you choose, replacing the lyrics it has after you confirm',
        firstReason(audioEntry)),
      makeRow('run-cover', 'Cover art from the file', 'image', 'Use the picture embedded in the audio file as its cover',
        firstReason(audioEntry)),
      makeRow('import', 'Save to the library', 'library-big', 'Import the loaded audio as a new library entry',
        f.kind === 'library' ? REASON.alreadyInLibrary : firstReason(bytes)),
      makeRow('delete', 'Delete from the library', 'trash-2', 'Delete the entry and its files, after you confirm',
        firstReason(entry), { danger: true }),
    ],
  };

  const stemRows: TrackMenuRow[] = (() => {
    const gate = firstReason(audioEntry, stems);
    if (gate !== null || f.stems.state !== 'known') {
      return [makeRow('stem-each', 'Send or save a stem', 'layers',
        'Send one separated stem to EDIT or MAKE, or save its file', gate ?? REASON.checking)];
    }
    return f.stems.value.flatMap((stem) =>
      STEM_KEYS.map((k) =>
        makeRow(stemRowId(k.action, stem.id), `${stem.name}: ${k.label}`, k.icon, k.does(stem.name), null, {
          goes: k.goes,
          line: { key: stem.id, label: stem.name },
        })));
  })();
  const stemsGroup: TrackMenuGroup = { id: 'stems', label: 'Stems', longJob: false, rows: stemRows };

  // Reading order, column by column on a 1366x768 screen: where it goes (Play,
  // Open in, Use in MAKE), the dock and MIDI, DJ and the jobs, the clipboard
  // and files, then the library record and the stems. The order is also what
  // lets whole groups pack into five columns at that size (see the test), and
  // Stems comes last so its height, which follows the stem count, moves nothing.
  return [play, open, make, dockGroup, midi, dj, analyze, copy, save, convert, library, stemsGroup];
}

const TAB_NAME: Record<string, string> = {
  make: 'MAKE', edit: 'EDIT', session: 'PERFORM', mix: 'MIX', dj: 'DJ', vj: 'VJ', sway: 'SWAY', foundry: 'FOUNDRY',
  underfit: 'UNDERFIT', nodefi: 'NodeF.I.', loom: 'LOOM', learn: 'LEARN', tour: 'TOUR',
  levels: 'LEVELS', spectral: 'SPECTRAL', details: 'DETAILS', score: 'SCORE', sing: 'SING', lyric: 'LYRIC',
  midi: 'MIDI', 'step-seq': 'STEP SEQ', draw: 'DRAW', slide: 'SLIDE',
};

/** The tab a row opens, as the tab bar and the dock print it. */
export const destinationName = (dest: TrackMenuDestination): string =>
  dest.area === 'library' ? 'the library' : TAB_NAME[dest.tab] ?? dest.tab.toUpperCase();

const EXT_BY_MIME: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
};

/** A file extension for loaded bytes that carry only a MIME type (a stem, a
 *  MIX render). Parameters such as `;codecs=opus` are ignored; unknown is wav,
 *  which is what every in-app render writes. */
export const audioExtForMime = (mime: string): string =>
  EXT_BY_MIME[(mime || '').split(';')[0].trim().toLowerCase()] ?? 'wav';

/** Every row, in menu order. */
export const allTrackMenuRows = (groups: TrackMenuGroup[]): TrackMenuRow[] => groups.flatMap((g) => g.rows);

/* ── packing the groups into columns ──────────────────────────────────── */

/** Sizes the card draws with. TrackMenu.tsx uses the same numbers as classes:
 *  a row, a stem line and a heading are h-6, groups sit gap-2 apart, chips sit
 *  three to a line in h-6 lines gap-1 apart, a column is w-62 and columns sit
 *  gap-2 apart inside p-2 and a 1px border. */
export const TRACK_MENU_ROW_PX = 24;
export const TRACK_MENU_HEADING_PX = 24;
export const TRACK_MENU_GROUP_GAP_PX = 8;
export const TRACK_MENU_CHIP_LINE_PX = 28;
export const TRACK_MENU_CHIPS_PER_LINE = 3;
export const TRACK_MENU_COLUMN_PX = 248;
export const TRACK_MENU_COLUMN_GAP_PX = 8;
/** The card's header (h-9), status line (h-8), body padding (p-2) and border. */
export const TRACK_MENU_CHROME_PX = 36 + 32 + 16 + 2;
/** The flyout keeps 6px from the screen edge. */
const SCREEN_PAD_PX = 6;

/** The tallest a column gets, whatever the screen. 640px holds the 1366x768
 *  arrangement, so a taller screen shows the same five columns in the same
 *  places (a group is where the hand learned it is) instead of fewer, taller
 *  ones that reach further from the key. */
export const TRACK_MENU_COLUMN_CAP_PX = 640;

/** Height the columns may take when the card may be `availablePx` tall. */
export const trackMenuColumnHeight = (availablePx: number): number =>
  Math.max(TRACK_MENU_ROW_PX * 4, Math.min(TRACK_MENU_COLUMN_CAP_PX, Math.floor(availablePx - TRACK_MENU_CHROME_PX)));

/** How many columns fit across a screen `viewportPx` wide (1 to 6). */
export const trackMenuMaxColumns = (viewportPx: number): number => {
  const inner = viewportPx - 2 * SCREEN_PAD_PX - (16 + 2) + TRACK_MENU_COLUMN_GAP_PX;
  return Math.max(1, Math.min(6, Math.floor(inner / (TRACK_MENU_COLUMN_PX + TRACK_MENU_COLUMN_GAP_PX))));
};

export function trackMenuGroupHeight(group: TrackMenuGroup): number {
  const chips = group.rows.filter((r) => r.chip).length;
  const lines = new Set(group.rows.filter((r) => r.line).map((r) => r.line?.key)).size;
  const rows = group.rows.filter((r) => !r.chip && !r.line).length;
  const chipLines = Math.ceil(chips / TRACK_MENU_CHIPS_PER_LINE);
  return TRACK_MENU_HEADING_PX + (rows + lines) * TRACK_MENU_ROW_PX + chipLines * TRACK_MENU_CHIP_LINE_PX;
}

export interface TrackMenuLayout {
  columns: TrackMenuGroup[][];
  /** Every column is within the height; false means the card scrolls. */
  fits: boolean;
}

const columnHeight = (col: TrackMenuGroup[]): number =>
  col.reduce((h, g, i) => h + (i > 0 ? TRACK_MENU_GROUP_GAP_PX : 0) + trackMenuGroupHeight(g), 0);

/** Fill columns in menu order, starting a new column when the next group would
 *  pass `limit`. A group is never split. */
const fillColumns = (groups: TrackMenuGroup[], limit: number): TrackMenuGroup[][] => {
  const columns: TrackMenuGroup[][] = [];
  let col: TrackMenuGroup[] = [];
  for (const g of groups) {
    const next = [...col, g];
    if (col.length > 0 && columnHeight(next) > limit) {
      columns.push(col);
      col = [g];
    } else {
      col = next;
    }
  }
  if (col.length > 0) columns.push(col);
  return columns;
};

/**
 * The fewest columns (at most `maxColumns`) that hold every group within
 * `columnHeightPx`, groups kept whole and in menu order, so the card is as
 * narrow as the screen height allows. When even `maxColumns` cannot hold them,
 * the groups are spread evenly across `maxColumns` and the card scrolls.
 */
export function packTrackMenuColumns(
  groups: TrackMenuGroup[],
  { maxColumns, columnHeightPx }: { maxColumns: number; columnHeightPx: number },
): TrackMenuLayout {
  const cap = Math.max(1, Math.floor(maxColumns));
  const packed = fillColumns(groups, columnHeightPx);
  if (packed.length <= cap) {
    return { columns: packed, fits: packed.every((c) => columnHeight(c) <= columnHeightPx) };
  }
  // Too tall for the screen: raise the limit until the groups fit in `cap`
  // columns, which spreads them as evenly as whole groups allow.
  const total = columnHeight(groups);
  let limit = Math.ceil(total / cap);
  let spread = fillColumns(groups, limit);
  while (spread.length > cap) {
    limit += TRACK_MENU_ROW_PX;
    spread = fillColumns(groups, limit);
  }
  return { columns: spread, fits: false };
}
