/**
 * playAlongStore — the SCORE tab's play-along preferences.
 *
 * One store for everything the STRIP / CHORDS / HIGHWAY views share: which
 * view is showing, the per-device visual latency offset, the highway's speed
 * and skin, the chord diagram instrument, and which parts of a multi-part
 * score are visible. Persisted in localStorage under 'score.playalong.v1'
 * (manually, with try/catch, like the other small stores) — EXCEPT
 * partVisibility, which is per artifact and session-only: a fresh session
 * should open a band score with the sensible default, not with whatever was
 * hidden last week on some other score.
 */
import { create } from 'zustand';

export type PlayAlongMode = 'page' | 'strip' | 'chords' | 'highway';
export type HighwaySkin = 'notation' | 'blocks' | 'drums';
export type HighwayDifficulty = 0 | 1 | 2 | 3 | 4;
export type ChordInstrument = 'guitar' | 'bass' | 'ukulele';
export type PlayAlongInstrument = 'all' | 'guitar' | 'bass' | 'keys' | 'drums' | 'vocals' | 'strings';

export const PLAY_ALONG_MODES: PlayAlongMode[] = ['page', 'strip', 'chords', 'highway'];
export const PLAY_ALONG_INSTRUMENTS: PlayAlongInstrument[] = [
  'all', 'guitar', 'bass', 'keys', 'drums', 'vocals', 'strings',
];

/** Visual offset bounds, ms. Positive = visuals later. */
export const USER_OFFSET_MIN_MS = -250;
export const USER_OFFSET_MAX_MS = 250;

const STORAGE_KEY = 'score.playalong.v1';

export interface PlayAlongPrefs {
  mode: PlayAlongMode;
  /** Visual latency compensation in ms; positive = visuals later. */
  userOffsetMs: number;
  /** Input latency compensation in ms, reserved for the judge (Wave 4). */
  inputOffsetMs: number;
  /** Highway approach speed, units per second. */
  approachSpeed: number;
  /** Seconds of highway visible ahead of the hit line. */
  leadInSec: number;
  skin: HighwaySkin;
  difficulty: HighwayDifficulty;
  chordInstrument: ChordInstrument;
  chordTuning: string;
  capo: number;
  judgeEnabled: boolean;
  /** Instrument preset: picks the parts and a sensible mode. */
  instrument: PlayAlongInstrument;
}

export interface PlayAlongState extends PlayAlongPrefs {
  /** Per artifact id: one flag per part, in the artifact's part order. */
  partVisibility: Record<string, boolean[]>;
  setMode: (mode: PlayAlongMode) => void;
  setUserOffsetMs: (ms: number) => void;
  setInputOffsetMs: (ms: number) => void;
  setApproachSpeed: (speed: number) => void;
  setLeadInSec: (sec: number) => void;
  setSkin: (skin: HighwaySkin) => void;
  setDifficulty: (difficulty: HighwayDifficulty) => void;
  setChordInstrument: (instrument: ChordInstrument) => void;
  setChordTuning: (tuning: string) => void;
  setCapo: (capo: number) => void;
  setJudgeEnabled: (enabled: boolean) => void;
  setInstrument: (instrument: PlayAlongInstrument) => void;
  setPartVisibility: (artifactId: string, visible: boolean[]) => void;
  togglePart: (artifactId: string, index: number) => void;
}

const DEFAULT_PREFS: PlayAlongPrefs = {
  mode: 'page',
  userOffsetMs: 0,
  inputOffsetMs: 0,
  approachSpeed: 8,
  leadInSec: 2.5,
  skin: 'notation',
  difficulty: 1,
  chordInstrument: 'guitar',
  chordTuning: 'guitar-standard',
  capo: 0,
  judgeEnabled: false,
  instrument: 'all',
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Coerce anything that came out of storage into a valid prefs object. */
function sanitize(raw: Partial<Record<keyof PlayAlongPrefs, unknown>>): PlayAlongPrefs {
  const difficulty = Math.round(finite(raw.difficulty, DEFAULT_PREFS.difficulty));
  return {
    mode: oneOf(raw.mode, PLAY_ALONG_MODES, DEFAULT_PREFS.mode),
    userOffsetMs: clamp(finite(raw.userOffsetMs, 0), USER_OFFSET_MIN_MS, USER_OFFSET_MAX_MS),
    inputOffsetMs: clamp(finite(raw.inputOffsetMs, 0), USER_OFFSET_MIN_MS, USER_OFFSET_MAX_MS),
    approachSpeed: clamp(finite(raw.approachSpeed, DEFAULT_PREFS.approachSpeed), 1, 40),
    leadInSec: clamp(finite(raw.leadInSec, DEFAULT_PREFS.leadInSec), 0.5, 10),
    skin: oneOf(raw.skin, ['notation', 'blocks', 'drums'] as const, DEFAULT_PREFS.skin),
    difficulty: (clamp(difficulty, 0, 4) as HighwayDifficulty),
    chordInstrument: oneOf(raw.chordInstrument, ['guitar', 'bass', 'ukulele'] as const, DEFAULT_PREFS.chordInstrument),
    chordTuning: typeof raw.chordTuning === 'string' && raw.chordTuning ? raw.chordTuning : DEFAULT_PREFS.chordTuning,
    capo: clamp(Math.round(finite(raw.capo, 0)), 0, 12),
    judgeEnabled: raw.judgeEnabled === true,
    instrument: oneOf(raw.instrument, PLAY_ALONG_INSTRUMENTS, DEFAULT_PREFS.instrument),
  };
}

function loadPrefs(): PlayAlongPrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_PREFS };
    return sanitize(parsed as Partial<Record<keyof PlayAlongPrefs, unknown>>);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(state: PlayAlongPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const prefs: PlayAlongPrefs = {
      mode: state.mode,
      userOffsetMs: state.userOffsetMs,
      inputOffsetMs: state.inputOffsetMs,
      approachSpeed: state.approachSpeed,
      leadInSec: state.leadInSec,
      skin: state.skin,
      difficulty: state.difficulty,
      chordInstrument: state.chordInstrument,
      chordTuning: state.chordTuning,
      capo: state.capo,
      judgeEnabled: state.judgeEnabled,
      instrument: state.instrument,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota: preferences just do not survive the reload */
  }
}

export const usePlayAlongStore = create<PlayAlongState>()((set, get) => {
  const update = (patch: Partial<PlayAlongPrefs>): void => {
    set(patch);
    savePrefs(get());
  };
  return {
    ...loadPrefs(),
    partVisibility: {},
    setMode: (mode) => update({ mode: oneOf(mode, PLAY_ALONG_MODES, 'page') }),
    setUserOffsetMs: (ms) =>
      update({ userOffsetMs: clamp(Math.round(finite(ms, 0)), USER_OFFSET_MIN_MS, USER_OFFSET_MAX_MS) }),
    setInputOffsetMs: (ms) =>
      update({ inputOffsetMs: clamp(Math.round(finite(ms, 0)), USER_OFFSET_MIN_MS, USER_OFFSET_MAX_MS) }),
    setApproachSpeed: (speed) => update({ approachSpeed: clamp(finite(speed, DEFAULT_PREFS.approachSpeed), 1, 40) }),
    setLeadInSec: (sec) => update({ leadInSec: clamp(finite(sec, DEFAULT_PREFS.leadInSec), 0.5, 10) }),
    setSkin: (skin) => update({ skin }),
    setDifficulty: (difficulty) => update({ difficulty: clamp(Math.round(difficulty), 0, 4) as HighwayDifficulty }),
    setChordInstrument: (chordInstrument) => update({ chordInstrument }),
    setChordTuning: (chordTuning) => update({ chordTuning }),
    setCapo: (capo) => update({ capo: clamp(Math.round(finite(capo, 0)), 0, 12) }),
    setJudgeEnabled: (judgeEnabled) => update({ judgeEnabled }),
    setInstrument: (instrument) => update({ instrument }),
    setPartVisibility: (artifactId, visible) =>
      set((s) => ({ partVisibility: { ...s.partVisibility, [artifactId]: visible.slice() } })),
    togglePart: (artifactId, index) =>
      set((s) => {
        const current = s.partVisibility[artifactId];
        if (!current || index < 0 || index >= current.length) return {};
        const next = current.slice();
        next[index] = !next[index];
        return { partVisibility: { ...s.partVisibility, [artifactId]: next } };
      }),
  };
});

/** Which play-along views make sense for an artifact kind. A musicxml sheet
 *  can be paged, stripped, chorded and charted; a tab has no note chart
 *  (alphaTex is not what the exporter reads); a note chart is only ever a
 *  highway; a chord track is only ever the chord strip; and anything else
 *  with a library entry (MIDI, ABC, PDF, SVG, a vocal transcript) can at least
 *  show chords estimated from the audio. */
export function allowedModes(kind: string): PlayAlongMode[] {
  switch (kind) {
    case 'musicxml':
      return ['page', 'strip', 'chords', 'highway'];
    case 'alphatex':
      return ['page', 'strip', 'chords'];
    case 'notechart':
      return ['highway'];
    case 'chordtrack':
      return ['chords'];
    default:
      return ['chords'];
  }
}

/** A part as the filter sees it: the name OSMD / the note chart reports, and
 *  whether it is a percussion staff. */
export interface PartDescriptor {
  name: string;
  isPercussion?: boolean;
}

/** Default part visibility: every part on, except that a part named 'full'
 *  (the whole-mix stem the band-score arranger includes next to the stems)
 *  starts hidden when there are other parts to read instead. */
export function defaultPartVisibility(parts: readonly PartDescriptor[]): boolean[] {
  if (parts.length <= 1) return parts.map(() => true);
  return parts.map((p) => !isFullMixPart(p.name));
}

const isFullMixPart = (name: string): boolean => {
  const n = (name || '').trim().toLowerCase();
  return n === 'full' || n.endsWith('__full') || n.endsWith(' full') || n.endsWith('-full') || n.endsWith('_full');
};

const INSTRUMENT_NAME_HINTS: Record<Exclude<PlayAlongInstrument, 'all' | 'drums'>, string[]> = {
  guitar: ['guitar'],
  bass: ['bass'],
  keys: ['piano', 'keys', 'keyboard', 'other'],
  vocals: ['vocal', 'voice', 'vox'],
  strings: ['string', 'violin', 'viola', 'cello'],
};

/** Which parts an instrument preset wants visible. Name matching is by
 *  substring on the lower-cased part name (the stems Demucs writes are named
 *  drums/bass/vocals/other/guitar/piano, which is what the band-score arranger
 *  turns into part names); drums also match by the percussion flag, which is
 *  how a real percussion staff is identified regardless of its name. 'all'
 *  is the plain default (everything but 'full'). When a preset matches no
 *  part at all, the default is returned rather than an empty score. */
export function partsForInstrument(
  instrument: PlayAlongInstrument,
  parts: readonly PartDescriptor[],
): boolean[] {
  if (instrument === 'all') return defaultPartVisibility(parts);
  const names = parts.map((p) => (p.name || '').toLowerCase());
  let visible: boolean[];
  if (instrument === 'drums') {
    visible = parts.map((p, i) => p.isPercussion === true || names[i].includes('drum'));
  } else {
    const hints = INSTRUMENT_NAME_HINTS[instrument];
    visible = names.map((n) => hints.some((h) => n.includes(h)));
  }
  if (!visible.some(Boolean)) return defaultPartVisibility(parts);
  return visible;
}

/** The view an instrument preset opens by default. Guitar and bass players
 *  read chords unless a tab artifact is what is selected; drums go straight
 *  to the drum highway; everyone else reads the strip. */
export function modeForInstrument(
  instrument: PlayAlongInstrument,
  artifactKind: string,
): { mode: PlayAlongMode; skin?: HighwaySkin } {
  const allowed = allowedModes(artifactKind);
  const pick = (wanted: PlayAlongMode): PlayAlongMode =>
    allowed.includes(wanted) ? wanted : allowed.includes('page') ? 'page' : allowed[0];
  switch (instrument) {
    case 'drums':
      return { mode: pick('highway'), skin: 'drums' };
    case 'guitar':
    case 'bass':
      return { mode: pick(artifactKind === 'alphatex' ? 'strip' : 'chords') };
    case 'keys':
    case 'strings':
    case 'vocals':
      return { mode: pick('strip') };
    default:
      return { mode: pick('page') };
  }
}
