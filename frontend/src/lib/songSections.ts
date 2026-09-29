/**
 * songSections — a library song's sections (backend/modules/sections) and the
 * places they go in the app:
 *
 *   - DETAILS lists them (SectionsBlock), and a rename or a new role is saved
 *     with the entry (PATCH /api/sections/{entry}/sections/{index})
 *   - EDIT: "Add section markers" on a clip of the song puts a timeline marker
 *     at each section start that falls inside the clip, placed where the clip
 *     plays that second of the song (its position, its trim, its stretch). The
 *     markers' ids name the clip (`sect:<clip>:<index>`), so they move and split
 *     with the clip and a second add replaces them
 *   - the MIDI tab: FORM writes a section marker at the bar line where each
 *     section starts in the roll, through the roll's tempo map (after MATCH the
 *     roll's bars are the song's), and fills the HARMONY row from the song's
 *     chord track
 *
 * No Vite-only imports, so node tests load it.
 */
import type { TimelineMarker } from '../state/editorStore';
import type { RollChordLabel } from './rollComposer';
import type { RollMarker } from './rollMarkers';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { SECTION_EDIT_MARKER_PREFIX, sanitizeRollMarkers } from './rollMarkers';
import type { StepClock } from './rollTempo';

export const SECTION_ROLES = ['intro', 'verse', 'chorus', 'drop', 'break', 'bridge', 'outro'] as const;
export type SectionRole = (typeof SECTION_ROLES)[number];

export const roleTitle = (role: string): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : '');

export interface SongSection {
  index: number;
  start_sec: number;
  end_sec: number;
  /** The bar it starts on, in the grid it was found on. */
  start_bar: number;
  bars: number;
  /** Repeat letter: 'A', 'B', "A'" (a varied repeat). */
  letter: string;
  role: string;
  name: string;
  /** 0..1: how clear the change into this section is (1 for the first). */
  confidence: number;
  /** The section this one repeats, or null. */
  repeat_of: number | null;
  similarity: number;
  energy: number;
  /** Each stem's (or HPSS part's) activity, 0..1. */
  stems: Record<string, number>;
  named_by_user?: boolean;
  role_by_user?: boolean;
}

export interface SongSectionsDoc {
  entry_id: string;
  status: 'ready' | 'pending';
  version?: number;
  found_at?: number;
  elapsed_sec?: number;
  duration_sec?: number;
  grid?: { source: 'rhythm' | 'beats' | 'tracked' | 'time'; bars: number };
  sections?: SongSection[];
  boundaries?: Array<{ bar: number; sec: number; confidence: number }>;
  stems?: string[];
  stems_are_parts?: boolean;
}

const base = (entryId: string) => `/api/sections/${encodeURIComponent(entryId)}`;

const readJson = async (res: Response): Promise<SongSectionsDoc> => {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      /* not JSON: the status says it */
    }
    throw new Error(detail);
  }
  return (await res.json()) as SongSectionsDoc;
};

/** The stored sections, or `status: 'pending'` when none are found yet. */
export async function fetchSongSections(entryId: string): Promise<SongSectionsDoc> {
  return readJson(await fetch(base(entryId)));
}

/** Find the sections now (the user's names and roles are kept). Seconds of CPU. */
export async function findSongSections(entryId: string): Promise<SongSectionsDoc> {
  return readJson(await fetch(`${base(entryId)}/run`, { method: 'POST' }));
}

/** The stored sections, finding them first when there are none. */
export async function songSectionsReady(entryId: string): Promise<SongSectionsDoc> {
  const doc = await fetchSongSections(entryId);
  return doc.status === 'ready' ? doc : findSongSections(entryId);
}

/** Rename and/or re-role one section; the answer is the whole stored document. */
export async function editSongSection(entryId: string, index: number, patch: { name?: string; role?: string }): Promise<SongSectionsDoc> {
  return readJson(
    await fetch(`${base(entryId)}/sections/${index}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

// ── EDIT ─────────────────────────────────────────────────────────────────────

/** The id of the EDIT marker section `index` of a song becomes on clip `clipId`. */
export const sectionEditMarkerId = (clipId: string, index: number): string => `${SECTION_EDIT_MARKER_PREFIX}${clipId}:${index}`;

/** Where a clip of the song sits on EDIT's timeline. */
export interface SectionClipPlacement {
  id: string;
  /** The clip's left edge on the timeline, in seconds. */
  startSec: number;
  /** The clip's trim into its audio, in audio seconds. */
  offsetIntoSource: number;
  /** The clip's length on the timeline, in seconds. */
  durationSec: number;
  /** The length of the clip's audio, in seconds. */
  sourceDuration: number;
  /** Audio seconds per timeline second (editorStore clipStretchRate): 1 unstretched. */
  rate: number;
}

/**
 * The EDIT markers for `sections` on a clip of the song: one at each section
 * start inside the clip's window, at the timeline second the clip plays it,
 * labelled with the section's name. A clip whose audio is a rendered stretch
 * of the song (its length differs from the song's by more than 1 %) maps the
 * song's seconds onto the audio's by their ratio.
 */
export function sectionEditMarkers(sections: readonly SongSection[], clip: SectionClipPlacement, songDurationSec: number): TimelineMarker[] {
  const rate = Number.isFinite(clip.rate) && clip.rate > 0 ? clip.rate : 1;
  const ratio = songDurationSec > 0 && clip.sourceDuration > 0 ? clip.sourceDuration / songDurationSec : 1;
  const scale = Math.abs(ratio - 1) > 0.01 ? ratio : 1;
  const eps = 1e-6;
  const out: TimelineMarker[] = [];
  for (const s of sections) {
    const audioSec = s.start_sec * scale;
    const rel = (audioSec - clip.offsetIntoSource) / rate;
    if (rel < -eps || rel > clip.durationSec + eps) continue;
    out.push({ id: sectionEditMarkerId(clip.id, s.index), t: Math.max(0, clip.startSec + Math.max(0, rel)), label: s.name });
  }
  return out;
}

// ── the piano roll ───────────────────────────────────────────────────────────

/** The bar line nearest `step` among `lines` (the roll's bar starts), or `step` when there are none. */
export const nearestLine = (lines: readonly number[], step: number): number => {
  let best: number | null = null;
  for (const l of lines) if (best === null || Math.abs(l - step) < Math.abs(best - step)) best = l;
  return best ?? step;
};

/**
 * One section marker per section, at the roll bar line nearest the step where
 * the section starts on the roll's clock. They carry `origin: 'form'` and ids
 * from their index (`section-<i>`), so writing them again replaces the last
 * ones and keeps every marker the user made or renamed (withFormMarkers). Two
 * sections that land on one bar line keep the later one.
 */
export function sectionRollMarkers(sections: readonly SongSection[], clock: Pick<StepClock, 'stepAt'>, lines: readonly number[]): RollMarker[] {
  return sanitizeRollMarkers(
    sections.map((s) => ({
      id: `section-${s.index}`,
      step: Math.max(0, nearestLine(lines, clock.stepAt(s.start_sec))),
      name: s.name,
      kind: 'section' as const,
      origin: 'form' as const,
    })),
  );
}

/** A chord of the song's chord track: its span and names (lib/chordTrack ChordSpan). */
export interface SongChord {
  startSec: number;
  symbol: string;
  roman?: string;
  romanKey?: string;
}

/**
 * The HARMONY row's figures from the song's chord track: each chord symbol at
 * the tick where it starts on the roll's clock, a chord the same as the one
 * before left out, a no-chord span left out. The roman figure and its key ride
 * along for the row's hover.
 */
export function chordTrackHarmony(chords: readonly SongChord[], clock: Pick<StepClock, 'stepAt'>, ticksPerStep = PPQ / ROLL_STEPS_PER_BEAT): RollChordLabel[] {
  const out: RollChordLabel[] = [];
  let last = '';
  for (const c of [...chords].sort((a, b) => a.startSec - b.startSec)) {
    const symbol = (c.symbol || '').trim();
    if (!symbol || symbol === 'N.C.') {
      last = '';
      continue;
    }
    if (symbol === last) continue;
    last = symbol;
    const tick = Math.max(0, Math.round(clock.stepAt(Math.max(0, c.startSec)) * ticksPerStep));
    if (out.length && out[out.length - 1].tick === tick) out.pop();
    out.push({
      tick,
      figure: symbol,
      ...(c.romanKey ? { key: c.romanKey } : {}),
      ...(c.roman ? { roman: c.roman } : {}),
    });
  }
  return out;
}

// ── DETAILS ──────────────────────────────────────────────────────────────────

/** A section start as the DETAILS list shows it: m:ss. */
export const sectionClock = (sec: number): string => {
  const whole = Math.max(0, Math.round(sec));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** The strip's fill per repeat letter; a varied repeat (A') is the letter's colour lighter. Whole class names, so Tailwind finds them. */
const LETTER_TONES: ReadonlyArray<readonly [string, string]> = [
  ['bg-emerald-400', 'bg-emerald-300'],
  ['bg-sky-400', 'bg-sky-300'],
  ['bg-amber-400', 'bg-amber-300'],
  ['bg-rose-400', 'bg-rose-300'],
  ['bg-violet-400', 'bg-violet-300'],
  ['bg-lime-400', 'bg-lime-300'],
  ['bg-orange-400', 'bg-orange-300'],
  ['bg-cyan-400', 'bg-cyan-300'],
];

export const letterTone = (letter: string): string => {
  const base = letter.replace(/[^A-Z]/g, '').charCodeAt(0);
  const pair = LETTER_TONES[Number.isFinite(base) ? (base - 65 + LETTER_TONES.length * 4) % LETTER_TONES.length : 0] ?? LETTER_TONES[0];
  return letter.includes("'") ? pair[1] : pair[0];
};

const GRID_WORDS: Record<NonNullable<SongSectionsDoc['grid']>['source'], string> = {
  rhythm: "the RHYTHM map's bars",
  beats: 'the analysis beats grouped in fours',
  tracked: 'beats tracked from the mix',
  time: 'two-second windows, as no beat could be read',
};

/** One line under the strip: how many bars, which grid, when it was found. */
export const gridWords = (doc: SongSectionsDoc | null): string => {
  if (!doc?.grid) return '';
  const n = doc.grid.bars;
  const stems = doc.stems?.length ? (doc.stems_are_parts ? 'the mix in parts' : `${doc.stems.length} stem${doc.stems.length === 1 ? '' : 's'}`) : 'the mix';
  return `${n} bar${n === 1 ? '' : 's'} on ${GRID_WORDS[doc.grid.source] ?? doc.grid.source}, read from ${stems}${doc.elapsed_sec ? ` in ${doc.elapsed_sec} s` : ''}`;
};
