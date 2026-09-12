/**
 * The one place that knows what a feature is, where it lives, and how to reveal
 * it.
 *
 * That knowledge used to be written down three times in three shapes — the tour
 * steps carried `targetSelector` + `tab` + `prepare`, the feature notes carried
 * `target` + `placement`, and the tab bars carried a `desc` tooltip — and the
 * library appeared in two of them under two different selectors pointing at two
 * different elements. Anything that needs to answer "where is X?" reads this
 * file instead of adding a fourth copy; each consumer keeps only the fields
 * that are its own business (a note's placement, a tour step's pacing and
 * copy, a search hit's ranking).
 *
 * Two things to know before editing:
 *
 *   - **a selector here is a DOM contract.** `[data-tour=...]` and
 *     `[data-feature-note=...]` look like dead attributes to anyone tidying
 *     JSX. Delete a hook and you must repoint or delete the entry in the same
 *     commit — nothing here fails loudly when an element goes away, the
 *     spotlight just quietly finds nothing.
 *   - **ids are prefixed where names collide.** A dock tab is `panel-<tab id>`
 *     because SWAY is both a workspace and a dock tab, and a few tab ids do not
 *     match their labels (PERFORM is `session`, VISUALIZE is `spectral`,
 *     SEQUENCE is `step-seq`). The `name` is what the user says out loud; the
 *     `id` is what the code says.
 *
 * This module is pure data — no DOM, no stores, no JSX — so a node test can
 * import it and so a search over it stays instant. The half that actually
 * touches app state (opening the rail, showing a dock tab) lives in
 * featureReveal.ts.
 */
import type { CenterTab } from '../state/appUiStore';
import type { BottomPanelTab } from '../state/bottomPanelStore';

/** Which part of the shell a feature belongs to — and so what has to be opened. */
export type FeatureSurface =
  | { kind: 'center'; tab: CenterTab }
  | { kind: 'dock'; tab: BottomPanelTab }
  | { kind: 'rail' }
  | { kind: 'shell' };

export interface FeatureLocate {
  /** The element to put the spotlight on. */
  selector: string;
  /** 'first' (default) or the 'union' of every match — the TourStep contract. */
  mode?: 'first' | 'union';
}

export interface FeatureEntry {
  /** Stable id. Center tabs use the bare tab id; dock tabs are `panel-<id>`. */
  id: string;
  /** The name as the user says it out loud. */
  name: string;
  /** One line: what it is. Present tense, no internal jargon. */
  what: string;
  /** Two to four steps: how to use it. One imperative sentence each. */
  how: string[];
  /** Where it lives, in the user's words: 'MAKE tab', 'Bottom dock'. */
  where: string;
  surface: FeatureSurface;
  /** Words people type that appear in none of the fields above. */
  aliases?: string[];
  /**
   * Heading TEXT in the User Guide — not a slug, not a section number, because
   * the guide's headings are numbered and inserting a section renumbers them.
   * The docs modal resolves it through its own table of contents.
   */
  guide?: string;
  /**
   * Absent when the feature has no single on-screen home; a card for one of
   * those offers no "show me" button rather than a spotlight that finds
   * nothing.
   */
  locate?: FeatureLocate;
  /** Offered as a starting point when a search box is still empty. */
  featured?: boolean;
  /** Present only in dev builds — hide it from anything user-facing. */
  devOnly?: boolean;
}

/** `[data-tour="..."]` hook, the one the tour and the spotlight both look for. */
const tourTarget = (id: string): FeatureLocate => ({ selector: `[data-tour="${id}"]` });

export const FEATURES: FeatureEntry[] = [
  // ── Workspaces (the center tab bar) ───────────────────────────────────────
  {
    id: 'make',
    name: 'MAKE',
    what: 'Generate audio from a text prompt with the AI models',
    how: [
      'Open the MAKE tab.',
      'Describe the sound you want in the prompt box.',
      'Press CREATE in the bottom-right corner.',
      'The finished audio lands in your library.',
    ],
    where: 'MAKE tab',
    surface: { kind: 'center', tab: 'make' },
    aliases: ['generate', 'create', 'text to audio', 'ai', 'song', 'music'],
    guide: 'MAKE Tab',
    locate: tourTarget('tab-make'),
    featured: true,
  },
  {
    id: 'edit',
    name: 'EDIT',
    what: 'Arrange clips on a timeline, add effects and automation, export',
    how: [
      'Open the EDIT tab.',
      'Drag a track in from the library.',
      'Cut, move and fade the clips on the timeline.',
      'Export the arrangement when it sounds right.',
    ],
    where: 'EDIT tab',
    surface: { kind: 'center', tab: 'edit' },
    aliases: ['timeline', 'arrange', 'daw', 'cut', 'trim', 'fade', 'automation'],
    guide: 'EDIT Tab',
    locate: tourTarget('tab-edit'),
  },
  {
    id: 'session',
    name: 'PERFORM',
    what: 'Import a project and perform its scene/clip grid live',
    how: [
      'Open the PERFORM tab.',
      'Import a project to fill the clip grid.',
      'Fire clips and scenes to play the arrangement live.',
    ],
    where: 'PERFORM tab',
    surface: { kind: 'center', tab: 'session' },
    aliases: ['session', 'clips', 'scenes', 'launch', 'live', 'ableton'],
    guide: 'Perform Tab',
    locate: tourTarget('tab-session'),
  },
  {
    id: 'mix',
    name: 'MIX',
    what: 'Process and master audio with the effect and module rack',
    how: [
      'Open the MIX tab.',
      'Select a track, then add effects from the rack.',
      'Set the levels and render the master.',
    ],
    where: 'MIX tab',
    surface: { kind: 'center', tab: 'mix' },
    aliases: ['master', 'mastering', 'effects', 'fx', 'rack', 'eq', 'compressor'],
    guide: 'MIX Tab',
    locate: tourTarget('tab-mix'),
  },
  {
    id: 'dj',
    name: 'DJ',
    what: 'Two-deck DJ console: mix, cue, scratch, stems and automix',
    how: [
      'Open the DJ tab.',
      'Load a track onto each deck.',
      'Beat-match with the crossfader, or hand it to automix.',
    ],
    where: 'DJ tab',
    surface: { kind: 'center', tab: 'dj' },
    aliases: ['deck', 'decks', 'crossfader', 'cue', 'scratch', 'automix', 'stems'],
    guide: 'DJ Tab',
    locate: tourTarget('tab-dj'),
  },
  {
    id: 'vj',
    name: 'VJ',
    what: 'Live visuals engine: sources, effects and output for performance',
    how: [
      'Open the VJ tab.',
      'Pick visual sources and stack effects on them.',
      'Send the result to an output window or a second screen.',
    ],
    where: 'VJ tab',
    surface: { kind: 'center', tab: 'vj' },
    aliases: ['visuals', 'video', 'projection', 'output', 'screen'],
    guide: 'VJ Tab',
    locate: tourTarget('tab-vj'),
  },
  {
    id: 'sway',
    name: 'SWAY',
    what: 'SwayCommand: gesture VJ cockpit for the Audima Sway, plus theDAW’s Sway routing',
    how: [
      'Open the SWAY tab.',
      'Connect the Sway, or use the camera as the pose source.',
      'Map a gesture to the parameter it should drive.',
    ],
    where: 'SWAY tab',
    surface: { kind: 'center', tab: 'sway' },
    aliases: ['gesture', 'swaycommand', 'audima', 'cockpit', 'hands'],
    locate: tourTarget('tab-sway'),
  },
  {
    id: 'foundry',
    name: 'FOUNDRY',
    what: 'Design and export custom VST / plugin interfaces on an infinite canvas',
    how: [
      'Open the FOUNDRY tab.',
      'Lay out knobs, sliders and artwork on the canvas.',
      'Export the design as a plugin interface.',
    ],
    where: 'FOUNDRY tab',
    surface: { kind: 'center', tab: 'foundry' },
    aliases: ['vst', 'plugin', 'interface', 'skin', 'canvas', 'design'],
    guide: 'Foundry Tab',
    locate: tourTarget('tab-foundry'),
  },
  {
    id: 'underfit',
    name: 'UNDERFIT',
    what: 'Train LoRA finetunes with the Underfit dashboard',
    how: [
      'Open the UNDERFIT tab.',
      'Point it at a folder of your own audio.',
      'Start the run, then pick the finished adapter in MAKE.',
    ],
    where: 'UNDERFIT tab',
    surface: { kind: 'center', tab: 'underfit' },
    aliases: ['train', 'training', 'lora', 'finetune', 'dataset', 'adapter'],
    guide: 'Underfit Tab',
    locate: tourTarget('tab-underfit'),
  },
  {
    id: 'nodefi',
    name: 'NODEFI',
    what: 'NodeF.I. — wire node graphs: AI pipelines offline, stems + rack FX live',
    how: [
      'Open the NODEFI tab.',
      'Drop nodes on the canvas and wire them together.',
      'Run the graph offline, or leave it live on the playing audio.',
    ],
    where: 'NODEFI tab',
    surface: { kind: 'center', tab: 'nodefi' },
    aliases: ['node', 'graph', 'patch', 'pipeline', 'wire', 'audimate'],
    guide: 'NodeF.I. Tab',
    locate: tourTarget('tab-nodefi'),
  },
  {
    id: 'loom',
    name: 'LOOM',
    what: 'LOOM — a Jacquard for your own catalogue: sequence shards of your songs on one beat clock',
    how: [
      'Open the LOOM tab.',
      'Let it shard the songs already in your library.',
      'Arrange the shards on the beat clock and let the colony grow.',
    ],
    where: 'LOOM tab',
    surface: { kind: 'center', tab: 'loom' },
    aliases: ['shards', 'jacquard', 'colony', 'remix', 'weave'],
    locate: tourTarget('tab-loom'),
  },
  {
    id: 'learn',
    name: 'LEARN',
    what: 'Guides, docs and the in-app assistant',
    how: [
      'Open the LEARN tab.',
      'Read a guide, or ask the assistant in plain language.',
    ],
    where: 'LEARN tab',
    surface: { kind: 'center', tab: 'learn' },
    aliases: ['help', 'assistant', 'tutorial', 'manual', 'chat', 'support'],
    guide: 'LEARN Tab',
    locate: tourTarget('tab-learn'),
    featured: true,
  },
  {
    id: 'tour',
    name: 'TOUR',
    what: 'Find venues and promoters by region, plan multi-stop tour routes',
    how: [
      'Open the TOUR tab.',
      'Pick a region to list its venues and promoters.',
      'Chain the stops you want into a route.',
    ],
    where: 'TOUR tab',
    surface: { kind: 'center', tab: 'tour' },
    aliases: ['venues', 'promoters', 'gigs', 'booking', 'route', 'map', 'shows'],
    guide: 'TOUR Tab',
    locate: tourTarget('tab-tour'),
  },

  // ── Bottom dock panels ────────────────────────────────────────────────────
  {
    id: 'panel-levels',
    name: 'LEVELS',
    what: 'Master loudness, peak, dynamics and stereo metering (LUFS / true-peak)',
    how: ['Open the LEVELS tab in the bottom dock.', 'Play the track and read the meters as it goes.'],
    where: 'Bottom dock → LEVELS',
    surface: { kind: 'dock', tab: 'levels' },
    aliases: ['lufs', 'meter', 'metering', 'loudness', 'peak', 'true peak', 'dynamics'],
    guide: 'Levels',
    locate: tourTarget('bottom-tab-levels'),
  },
  {
    id: 'panel-spectral',
    name: 'VISUALIZE',
    what: 'Live spectrum + waveform visualizer of the playing audio',
    how: ['Open the VISUALIZE tab in the bottom dock.', 'Press play — the spectrum follows the audio.'],
    where: 'Bottom dock → VISUALIZE',
    surface: { kind: 'dock', tab: 'spectral' },
    aliases: ['spectrum', 'visualizer', 'fft', 'waveform', 'analyser', 'scope'],
    guide: 'Bottom Panel Tabs',
    locate: tourTarget('bottom-tab-spectral'),
  },
  {
    id: 'panel-midi',
    name: 'MIDI',
    what: 'Piano roll: sing in, record or analyze notes, edit them, export MIDI',
    how: [
      'Open the MIDI tab in the bottom dock.',
      'Sing, play or analyze a track to fill the roll with notes.',
      'Drag the notes to edit, then export a MIDI file.',
    ],
    where: 'Bottom dock → MIDI',
    surface: { kind: 'dock', tab: 'midi' },
    aliases: ['piano roll', 'pianoroll', 'notes', 'note editor', 'keys'],
    guide: 'Piano Roll',
    locate: tourTarget('bottom-tab-midi'),
  },
  {
    id: 'panel-step-seq',
    name: 'SEQUENCE',
    what: 'Program drum and note patterns step by step on a grid',
    how: [
      'Open the SEQUENCE tab in the bottom dock.',
      'Click the steps you want to sound.',
      'Play the pattern and record it where you need it.',
    ],
    where: 'Bottom dock → SEQUENCE',
    surface: { kind: 'dock', tab: 'step-seq' },
    aliases: ['step sequencer', 'drums', 'pattern', 'grid', 'beat', 'drum machine'],
    guide: 'Step Sequencer',
    locate: tourTarget('bottom-tab-step-seq'),
  },
  {
    id: 'panel-draw',
    name: 'DRAW',
    what: 'Draw to play generative music; record it to the library or EDIT',
    how: [
      'Open the DRAW tab in the bottom dock.',
      'Sketch on the pad — the shape becomes the music.',
      'Record the take straight into the library.',
    ],
    where: 'Bottom dock → DRAW',
    surface: { kind: 'dock', tab: 'draw' },
    aliases: ['sketch', 'doodle', 'generative', 'paint', 'pad'],
    guide: 'DRAW',
    locate: tourTarget('bottom-tab-draw'),
  },
  {
    id: 'panel-score',
    name: 'SCORE',
    what: 'Sheet music + tabs for the selection; convert and arrange notation',
    how: [
      'Select a track, then open the SCORE tab in the bottom dock.',
      'Convert the audio to notation.',
      'Arrange the parts, then EXPORT as MusicXML, PDF, ABC, SVG (needs MuseScore), a note chart or a Beat Saber level.',
    ],
    where: 'Bottom dock → SCORE',
    surface: { kind: 'dock', tab: 'score' },
    aliases: ['notation', 'sheet music', 'tab', 'tabs', 'chords', 'staff', 'guitar'],
    guide: 'Notation, Score, Tabs, and Arrangements',
    locate: tourTarget('bottom-tab-score'),
  },
  {
    id: 'panel-sing',
    name: 'SING',
    what: 'Karaoke: lyrics follow the track word by word; paste, extract, align, tap-time and export LRC',
    how: [
      'Select a track, then open the SING tab in the bottom dock.',
      'Paste the lyrics, or extract them from the vocal.',
      'Align them to the audio and export an LRC.',
    ],
    where: 'Bottom dock → SING',
    surface: { kind: 'dock', tab: 'sing' },
    aliases: ['karaoke', 'lyrics', 'lrc', 'align', 'vocals', 'words', 'subtitles'],
    guide: 'Bottom Panel Tabs',
    locate: tourTarget('bottom-tab-sing'),
  },
  {
    id: 'panel-lyric',
    name: 'LYRIC',
    what: 'Write, edit and analyse lyrics with no song attached; save a draft into a song when it is ready',
    how: [
      'Open the LYRIC tab in the bottom dock.',
      'Write a draft — rhyme, meter and repeated devices are marked as you type.',
      'Save the draft into a song once it is ready.',
    ],
    where: 'Bottom dock → LYRIC',
    surface: { kind: 'dock', tab: 'lyric' },
    aliases: ['lyrics', 'writing', 'notepad', 'rhyme', 'verse', 'words'],
    guide: 'Bottom Panel Tabs',
    locate: tourTarget('bottom-tab-lyric'),
  },
  {
    id: 'panel-details',
    name: 'DETAILS',
    what: 'The selected library item (metadata, prompt, analysis) and the media bucket for staging clips and files',
    how: [
      'Select a library item, then open the DETAILS tab in the bottom dock.',
      'Read its prompt, metadata and analysis.',
      'Drop clips and files into the media bucket to stage them.',
    ],
    where: 'Bottom dock → DETAILS',
    surface: { kind: 'dock', tab: 'details' },
    aliases: ['metadata', 'info', 'properties', 'media', 'bucket', 'prompt'],
    guide: 'Details',
    locate: tourTarget('bottom-tab-details'),
  },
  {
    id: 'panel-slide',
    name: 'SLIDE',
    what: 'Control surface: map sliders and pads to parameters',
    how: [
      'Open the SLIDE tab in the bottom dock.',
      'Map a slider or pad to the parameter it should move.',
      'Drive it from the phone companion or a controller.',
    ],
    where: 'Bottom dock → SLIDE',
    surface: { kind: 'dock', tab: 'slide' },
    aliases: ['controller', 'macro', 'pads', 'faders', 'sliders', 'mapping'],
    guide: 'Bottom Panel Tabs',
    locate: tourTarget('bottom-tab-slide'),
  },
  {
    id: 'panel-sway',
    name: 'SWAY panel',
    what: 'Wire the Sway — or any MIDI controller — into theDAW: learn its six motion dimensions, route them and the camera pose to parameters, or mirror the whole surface onto the EDIT mixer',
    how: [
      'Open the SWAY tab in the bottom dock and turn MIDI input on.',
      'Press LEARN on a dimension, then move the control it should follow.',
      'Route it to a parameter, or switch DAW Control on to drive the transport, faders and pads instead.',
      'Camera pose needs no learn — turn GESTURE on in the VJ and route those channels the same way.',
    ],
    where: 'Bottom dock → SWAY',
    surface: { kind: 'dock', tab: 'sway' },
    aliases: ['pose', 'camera', 'body', 'movement', 'gesture', 'midi learn', 'controller', 'mapping', 'routing'],
    guide: 'Bottom Panel Tabs',
    locate: tourTarget('bottom-tab-sway'),
  },
  {
    id: 'panel-xrbus',
    name: 'XR BUS',
    what: 'Dev: simulated XR/phone controller driving the control bus',
    how: ['Open the XR BUS tab in the bottom dock.', 'Move the simulated controls and watch the bus react.'],
    where: 'Bottom dock → XR BUS',
    surface: { kind: 'dock', tab: 'xrbus' },
    aliases: ['dev', 'diagnostics', 'control bus', 'simulator'],
    locate: tourTarget('bottom-tab-xrbus'),
    devOnly: true,
  },

  // ── Shell chrome: the things with no label of their own ────────────────────
  {
    id: 'library',
    name: 'Library',
    what: 'Everything you make or import lives here — play it, drag it into a workspace, export stems and MIDI',
    how: [
      'Click the LIBRARY tab on the right edge to slide the rail out.',
      'Click an item to select it; drag it into EDIT, DJ or the Chimera stack.',
      'Right-click one for stems, MIDI, cover art and export.',
    ],
    where: 'Right edge',
    surface: { kind: 'rail' },
    aliases: ['songs', 'tracks', 'files', 'catalogue', 'browser', 'my music', 'saved'],
    guide: 'Library',
    // The RAIL, not the edge handle that opens it — the feature note points at
    // the handle, because that is the affordance nobody could find.
    locate: tourTarget('library'),
    featured: true,
  },
  {
    id: 'log',
    name: 'Log',
    what: 'Machine stats and every job the app has run',
    how: ['Click LOG in the bottom strip to expand it.', 'Read the job history, or the live CPU, GPU and memory readouts.'],
    where: 'Bottom strip, right',
    surface: { kind: 'shell' },
    aliases: ['console', 'jobs', 'errors', 'history', 'gpu', 'vram', 'stats'],
    guide: 'Processing Log',
    locate: { selector: '[data-feature-note="log"]' },
  },
  {
    id: 'panels',
    name: 'Panels',
    what: 'The dock strip that opens score, lyrics, levels, MIDI and the rest',
    how: ['Click PANELS in the bottom strip to open the dock.', 'Pick the panel you want from the tab row.'],
    where: 'Bottom strip, left',
    surface: { kind: 'shell' },
    aliases: ['dock', 'bottom', 'strip', 'drawer', 'tabs'],
    guide: 'Bottom Panel Tabs',
    locate: { selector: '[data-feature-note="panels"]' },
  },
  {
    id: 'app-menu',
    name: 'App menu',
    what: 'Settings, models, projects, docs and the feature tour',
    how: ['Click the ☰ button at the far right of the header.', 'Open Settings to download and switch on models and modules.'],
    where: 'Header, far right',
    surface: { kind: 'shell' },
    aliases: ['hamburger', 'settings', 'preferences', 'options', 'models', 'project'],
    guide: 'App Menu and Project Operations',
    locate: tourTarget('app-menu'),
    featured: true,
  },
  {
    id: 'import',
    name: 'Import',
    what: 'Bring audio files, a .tasmo project or a DAW project into theDAW from any tab',
    how: [
      'Click IMPORT in the header — it is in the same place on every tab.',
      'Choose Audio files to add tracks to the library, Open project for a .tasmo, or DAW project for an Ableton set.',
      'Or drop audio files straight onto the IMPORT button.',
    ],
    where: 'Header, right',
    surface: { kind: 'shell' },
    aliases: ['open', 'load', 'add', 'upload', 'file', 'files', 'audio files', 'tracks', 'tasmo', 'ableton', 'als', 'daw project'],
    guide: 'App Menu and Project Operations',
    locate: tourTarget('import'),
  },
  {
    id: 'prompt',
    name: 'Prompt box',
    what: 'Where you describe the sound you want before pressing CREATE',
    how: [
      'Open the MAKE tab.',
      'Type what you want to hear — "warm lo-fi beat, vinyl crackle, 90 BPM".',
      'Press CREATE in the bottom-right corner.',
    ],
    where: 'MAKE tab',
    surface: { kind: 'center', tab: 'make' },
    aliases: ['describe', 'text', 'words', 'write', 'ask'],
    guide: 'MAKE Tab',
    locate: { selector: 'textarea[name="gen-prompt"]' },
    featured: true,
  },
  {
    id: 'chimera',
    name: 'Chimera',
    what: 'Splices two or more clips into one new sound, the way DNA strands combine',
    how: [
      'Open the MAKE tab.',
      'Drop two or more clips into the Chimera stack.',
      'Splice them — the hybrid lands in your library.',
    ],
    where: 'MAKE tab',
    surface: { kind: 'center', tab: 'make' },
    aliases: ['splice', 'crispr', 'dna', 'mashup', 'combine', 'hybrid', 'blend'],
    guide: 'MAKE Tab',
    locate: { selector: '[data-crispr-output]' },
  },
  {
    id: 'docs',
    name: 'Docs',
    what: 'The full manual, searchable by heading',
    how: [
      'Click ? in the header.',
      'Click the book icon beside the search field.',
      'Filter the table of contents to jump to a section.',
    ],
    where: 'Header, behind ?',
    surface: { kind: 'shell' },
    aliases: ['manual', 'documentation', 'handbook', 'user guide', 'readme', 'reference'],
    guide: 'UI Shell',
    // Rings the ? button, which is where the manual now lives.
    locate: tourTarget('help'),
  },
  {
    id: 'feature-tour',
    name: 'Feature tour',
    what: 'The guided walkthrough of the app, replayable any time',
    how: ['Open the ☰ menu, or HOME, and start the tour.', 'Use ← and → to move, Esc to leave.'],
    where: 'HOME and the ☰ menu',
    surface: { kind: 'shell' },
    aliases: ['walkthrough', 'onboarding', 'intro', 'guided', 'first run'],
    guide: 'HOME Screen and Onboarding Tour',
  },
];

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

export function featureById(id: string): FeatureEntry | undefined {
  return BY_ID.get(id);
}
