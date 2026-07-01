// Genre / style drum-pattern library for the Step Sequencer.
//
// Each style defines a one-bar (16 sixteenth-step) pattern per drum ROLE
// (kick / snare / hat / bass / perc). A sequencer track is mapped to a role by
// its voice (kick|snare|hat|tone|noise) with a name-keyword override, then the
// style's pattern for that role fills the track's 16 steps.
//
// "Combine" unions the active steps of several styles for each role, so a user
// can layer e.g. house + futurebass. Patterns loop the single bar.

export const STEPS = 16;

export type Role = 'kick' | 'snare' | 'hat' | 'bass' | 'perc';

export interface StylePattern {
  kick: number[];
  snare: number[];
  hat: number[];
  bass: number[];
  perc: number[];
}

const ALL = Array.from({ length: STEPS }, (_, i) => i); // every 16th
const EVEN = [0, 2, 4, 6, 8, 10, 12, 14];
const OFFB = [2, 6, 10, 12 + 2]; // classic open-hat offbeats -> 2,6,10,14
const FOUR = [0, 4, 8, 12];
const BACKBEAT = [4, 12];

// A style is a partial spec; empty roles fall back to sensible defaults so a
// track never ends up silent when a style targets only some roles.
const STYLES_RAW: Record<string, Partial<StylePattern>> = {
  // --- Electronic / club ---
  House: {
    kick: FOUR,
    snare: BACKBEAT,
    hat: [2, 6, 10, 14],
    bass: [0, 3, 6, 8, 11, 14],
    perc: [2, 6, 10, 14],
  },
  Dubstep: {
    // Half-time: snare lands on beat 3 only.
    kick: [0, 10],
    snare: [8],
    hat: [0, 4, 8, 12],
    bass: [0, 8, 11],
    perc: [4, 12],
  },
  Futurebass: {
    kick: [0, 6, 8, 14],
    snare: BACKBEAT,
    hat: [2, 6, 10, 14],
    bass: [0, 8],
    perc: [3, 7, 11, 15],
  },
  Trap: {
    kick: [0, 3, 7, 10],
    snare: [8],
    hat: ALL,
    bass: [0, 10],
    perc: [8],
  },
  'Drum & Bass': {
    kick: [0, 10],
    snare: [4, 12],
    hat: EVEN,
    bass: [0, 6, 10],
    perc: [2, 6, 10, 14],
  },
  Breakbeat: {
    kick: [0, 6, 10],
    snare: [4, 12],
    hat: EVEN,
    bass: [0, 6, 10],
    perc: [3, 11],
  },
  // --- Jazz family ---
  'Fire-jazz': {
    kick: [0, 8],
    snare: [2, 6, 10, 14],
    hat: [0, 3, 4, 7, 8, 11, 12, 15], // swung ride
    bass: [0, 4, 8, 12],
    perc: [4, 12],
  },
  'Smooth jazz': {
    kick: [0, 8],
    snare: BACKBEAT,
    hat: OFFB,
    bass: [0, 6, 8, 14],
    perc: [2, 6, 10, 14],
  },
  'Big band': {
    kick: [0, 8],
    snare: BACKBEAT,
    hat: [0, 3, 4, 7, 8, 11, 12, 15], // swing ride
    bass: [0, 4, 8, 12],
    perc: [4, 12],
  },
  // --- Metal / rock ---
  'Death metal': {
    // Blast beat: kick + snare alternate on 16ths.
    kick: EVEN,
    snare: [1, 3, 5, 7, 9, 11, 13, 15],
    hat: ALL,
    bass: EVEN,
    perc: [0, 8],
  },
  'Technical death metal': {
    // Gravity/irregular blast.
    kick: [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14],
    snare: FOUR,
    hat: ALL,
    bass: [0, 4, 8, 12],
    perc: [2, 6, 10, 14],
  },
  Metalcore: {
    // Galloping kick with breakdown backbeat.
    kick: [0, 3, 4, 7, 8, 11, 12, 15],
    snare: BACKBEAT,
    hat: EVEN,
    bass: [0, 3, 6, 8, 11, 14],
    perc: [4, 12],
  },
  Djent: {
    // Syncopated palm-mute gallop.
    kick: [0, 3, 6, 7, 10, 13],
    snare: BACKBEAT,
    hat: FOUR,
    bass: [0, 3, 6, 7, 10, 13],
    perc: [4, 12],
  },
  Prog: {
    kick: [0, 4, 7, 10, 14],
    snare: BACKBEAT,
    hat: EVEN,
    bass: [0, 4, 7, 10, 14],
    perc: [2, 10],
  },
  'Power metal': {
    kick: EVEN,
    snare: BACKBEAT,
    hat: EVEN,
    bass: EVEN,
    perc: [0, 8],
  },
  'Classic rock': {
    kick: [0, 7, 8],
    snare: BACKBEAT,
    hat: EVEN,
    bass: [0, 8],
    perc: [4, 12],
  },
  // --- Acoustic / percussion ---
  Taiko: {
    kick: [0, 2, 4, 6, 8, 10, 12, 14],
    snare: [0, 8],
    hat: [],
    bass: [0, 4, 8, 12],
    perc: [0, 4, 8, 12],
  },
  Marching: {
    kick: FOUR,
    snare: [0, 2, 3, 4, 6, 8, 10, 11, 12, 14],
    hat: [],
    bass: FOUR,
    perc: [0, 4, 8, 12],
  },
  // --- Groove / hip-hop / latin ---
  'Hip-hop': {
    kick: [0, 6, 10],
    snare: BACKBEAT,
    hat: EVEN,
    bass: [0, 6, 10],
    perc: [2, 10],
  },
  Funk: {
    kick: [0, 6, 10],
    snare: BACKBEAT,
    hat: ALL,
    bass: [0, 3, 6, 10, 13],
    perc: [2, 6, 10, 14],
  },
  Reggaeton: {
    kick: [0, 8],
    snare: [3, 6, 11, 14], // dembow
    hat: EVEN,
    bass: [0, 8],
    perc: [3, 6, 11, 14],
  },
};

/** Public list of style names (declaration order). */
export const STYLE_NAMES: string[] = Object.keys(STYLES_RAW);

const idxToBool = (idx: number[]): boolean[] => {
  const out = Array<boolean>(STEPS).fill(false);
  for (const i of idx) if (i >= 0 && i < STEPS) out[i] = true;
  return out;
};

// Fallbacks so a style targeting only some roles still gives every track something.
const DEFAULTS: StylePattern = {
  kick: FOUR,
  snare: BACKBEAT,
  hat: EVEN,
  bass: [0, 8],
  perc: [2, 6, 10, 14],
};

const resolve = (name: string): StylePattern => {
  const raw = STYLES_RAW[name] || {};
  return {
    kick: raw.kick ?? DEFAULTS.kick,
    snare: raw.snare ?? DEFAULTS.snare,
    hat: raw.hat ?? DEFAULTS.hat,
    bass: raw.bass ?? DEFAULTS.bass,
    perc: raw.perc ?? DEFAULTS.perc,
  };
};

/** Booleans for one role of one style. */
export const patternForRole = (style: string, role: Role): boolean[] =>
  idxToBool(resolve(style)[role]);

/** Union the active steps of several styles for a role ("combine" mode). */
export const combineStylesForRole = (styles: string[], role: Role): boolean[] => {
  const out = Array<boolean>(STEPS).fill(false);
  for (const s of styles) {
    const pat = resolve(s)[role];
    for (const i of pat) if (i >= 0 && i < STEPS) out[i] = true;
  }
  return out;
};

/** Map a sequencer track to a drum role: name keyword wins, else the voice. */
export const roleForTrack = (track: { name: string; voice: string }): Role => {
  const n = (track.name || '').toLowerCase();
  if (/\bkick|\bbd\b|bass ?drum/.test(n)) return 'kick';
  if (/snare|clap|\bsd\b|rim/.test(n)) return 'snare';
  if (/hat|hi-?hat|ride|cymbal/.test(n)) return 'hat';
  if (/bass|sub|808/.test(n)) return 'bass';
  if (/perc|shaker|tom|conga|tamb/.test(n)) return 'perc';
  switch (track.voice) {
    case 'kick':
      return 'kick';
    case 'snare':
      return 'snare';
    case 'hat':
      return 'hat';
    case 'tone':
      return 'bass';
    default:
      return 'perc';
  }
};
