/**
 * rollMarkers — named markers on the piano roll's ruler: sections (rehearsal
 * letters, FORM's Intro / Theme / Chorus) and movements (I, II, III).
 *
 * A marker is a place and a name. The place is a whole tick at the roll's PPQ,
 * the clock the notes keep, so a marker stays on the note it names through a
 * meter change, a tempo change and a bounce, exactly as the notes do. The step
 * the ruler draws it at is `tick / TICKS_PER_STEP`.
 *
 * The roll holds its markers in its document (undo covers them). A bounce
 * copies them onto the clip as `sourceMarkers`, a .tasmo clip saves them as
 * `roll_markers`, and the bounce also writes each one to EDIT's timeline as a
 * marker whose id names the clip and the marker (`roll:<clip>:<marker>`), so a
 * second bounce of the same clip replaces its markers there and never doubles
 * them.
 *
 * A marker FORM wrote when a song was built carries `origin: 'form'`. The next
 * build replaces those and keeps every other marker; renaming, moving or
 * retyping a FORM marker makes it the user's own (the origin goes).
 *
 * No Vite-only imports, so node tests load it.
 */
import type { TimelineMarker } from '../state/editorStore';
import { barAt, type MeterSegment } from './meterMap';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { stepClock } from './rollTempo';
import type { TempoEvent } from './tempoMap';

export type RollMarkerKind = 'section' | 'movement';

export interface RollMarker {
  id: string;
  /** Where the marker sits: whole ticks at PPQ from the roll's first step. */
  tick: number;
  /** What the ruler, the jump list and EDIT show. Never blank. */
  name: string;
  kind: RollMarkerKind;
  /** 'form' when a FORM section wrote it at a song build; absent on the user's own. */
  origin?: 'form';
}

/** A marker as a caller hands it in: a place in ticks or in steps, anything else optional. */
export interface RollMarkerInput {
  id?: string;
  tick?: number;
  step?: number;
  name?: string;
  kind?: RollMarkerKind;
  origin?: 'form';
}

/** Ticks in one of the roll's 16th steps. */
export const MARKER_TICKS_PER_STEP = PPQ / ROLL_STEPS_PER_BEAT;

/** The longest name a marker keeps; longer text is cut here. */
export const MARKER_NAME_MAX = 64;

/** The prefix of an EDIT timeline marker a roll clip wrote. */
export const ROLL_EDIT_MARKER_PREFIX = 'roll:';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const isRollMarkerKind = (v: unknown): v is RollMarkerKind => v === 'section' || v === 'movement';

/** The step a marker is drawn at. */
export const markerStep = (m: Pick<RollMarker, 'tick'>): number => m.tick / MARKER_TICKS_PER_STEP;

/** A step as a marker's tick: whole, never negative. */
export const markerTickOfStep = (step: number): number => Math.max(0, Math.round((isNum(step) ? step : 0) * MARKER_TICKS_PER_STEP));

const ROMAN: ReadonlyArray<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/** 1 → I, 4 → IV, 12 → XII. */
export const romanNumeral = (n: number): string => {
  let left = Math.max(1, Math.floor(n));
  let out = '';
  for (const [value, glyph] of ROMAN) {
    while (left >= value) {
      out += glyph;
      left -= value;
    }
  }
  return out;
};

/** 0 → A, 25 → Z, 26 → AA: rehearsal letters. */
export const rehearsalLetter = (index: number): string => {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
};

/**
 * The name a new marker of `kind` gets: the first rehearsal letter (sections)
 * or roman numeral (movements) no marker of that kind already uses.
 */
export const nextMarkerName = (markers: readonly Pick<RollMarker, 'name' | 'kind'>[], kind: RollMarkerKind): string => {
  const used = new Set(markers.filter((m) => m.kind === kind).map((m) => m.name.trim().toUpperCase()));
  for (let i = 0; i < 10000; i += 1) {
    const name = kind === 'movement' ? romanNumeral(i + 1) : rehearsalLetter(i);
    if (!used.has(name)) return name;
  }
  return kind === 'movement' ? 'Movement' : 'Section';
};

/** A name brought into shape: one line, trimmed, at most MARKER_NAME_MAX characters, or `fallback` when nothing is left. */
export const cleanMarkerName = (name: unknown, fallback: string): string => {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MARKER_NAME_MAX).trim() : '';
  return text || fallback;
};

const uidMarker = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `mk-${crypto.randomUUID()}` : `mk-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Movement before section at one tick, so a movement's first section reads after its title. */
const kindOrder = (k: RollMarkerKind): number => (k === 'movement' ? 0 : 1);

/** The order the ruler, the jump list, a save and EDIT all read markers in. */
export const byMarkerPlace = (a: RollMarker, b: RollMarker): number => a.tick - b.tick || kindOrder(a.kind) - kindOrder(b.kind);

/**
 * Markers the roll can hold, sorted by place (byMarkerPlace). A marker needs a
 * place (`tick`, else `step`), finite and not negative; anything else is left
 * out. Its kind defaults to a section, its name to the next free letter or
 * numeral, and a missing id gets a fresh one. Two markers with one id keep the
 * first, and two of one kind at one tick keep the later one, as a tempo map
 * keeps the later of two tempos on one beat.
 */
export const sanitizeRollMarkers = (list: readonly (RollMarkerInput | null | undefined)[] | null | undefined): RollMarker[] => {
  const byId = new Set<string>();
  const byPlace = new Map<string, RollMarker>();
  const named: RollMarker[] = [];
  for (const raw of list ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const tick = isNum(raw.tick) && raw.tick >= 0 ? Math.round(raw.tick) : isNum(raw.step) && raw.step >= 0 ? markerTickOfStep(raw.step) : null;
    if (tick === null) continue;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : uidMarker();
    if (byId.has(id)) continue;
    byId.add(id);
    const kind: RollMarkerKind = isRollMarkerKind(raw.kind) ? raw.kind : 'section';
    const marker: RollMarker = {
      id,
      tick,
      name: cleanMarkerName(raw.name, nextMarkerName(named, kind)),
      kind,
      ...(raw.origin === 'form' ? { origin: 'form' as const } : {}),
    };
    named.push(marker);
    const place = `${kind}@${tick}`;
    const before = byPlace.get(place);
    if (before) byId.delete(before.id);
    byPlace.set(place, marker);
  }
  return [...byPlace.values()].sort(byMarkerPlace);
};

/** The marker of `kind` at `tick`, other than `exceptId`: the one an edit landing there would collide with. */
export const markerAtPlace = (
  markers: readonly RollMarker[],
  kind: RollMarkerKind,
  tick: number,
  exceptId?: string,
): RollMarker | null => markers.find((m) => m.kind === kind && m.tick === tick && m.id !== exceptId) ?? null;

/** A deep copy of a marker list, for a clip field or a save. */
export const copyRollMarkers = (markers: readonly RollMarker[]): RollMarker[] => markers.map((m) => ({ ...m }));

/** True when two marker lists hold the same markers in the same order. */
export const sameRollMarkers = (a: readonly RollMarker[], b: readonly RollMarker[]): boolean =>
  a.length === b.length
  && a.every((m, i) => m.id === b[i].id && m.tick === b[i].tick && m.name === b[i].name && m.kind === b[i].kind && m.origin === b[i].origin);

/** "Bar 12", or "Pickup" for a marker before bar 1. */
export const markerBarLabel = (m: Pick<RollMarker, 'tick'>, meterMap: readonly MeterSegment[], pickupSteps: number): string => {
  const bar = barAt(meterMap, markerStep(m), pickupSteps);
  return bar.bar < 0 ? 'Pickup' : `Bar ${bar.bar + 1}`;
};

/** What a screen reader hears for a marker: "Movement II. Adagio, bar 40". */
export const markerSpoken = (m: RollMarker, meterMap: readonly MeterSegment[], pickupSteps: number): string =>
  `${m.kind === 'movement' ? 'Movement' : 'Section'} ${m.name}, ${markerBarLabel(m, meterMap, pickupSteps).toLowerCase()}`;

/** The markers before and after `step`: the jump list's previous and next. */
export const markerAround = (markers: readonly RollMarker[], step: number): { prev: RollMarker | null; next: RollMarker | null } => {
  let prev: RollMarker | null = null;
  let next: RollMarker | null = null;
  const at = markerTickOfStep(step);
  for (const m of markers) {
    if (m.tick < at) prev = m;
    else if (m.tick > at && !next) next = m;
  }
  return { prev, next };
};

// ── FORM sections ────────────────────────────────────────────────────────────

/** A section of a built song: its label and where it starts, in the roll's steps. */
export interface FormSectionPlace {
  label: string;
  step: number;
}

/**
 * One section marker per FORM section, at its first bar line, named by its
 * role; a role that comes back is numbered ("Theme", "Theme 2"). Each carries
 * `origin: 'form'` and an id from its index, so a rebuild writes the same ids.
 */
export const formSectionMarkers = (sections: readonly FormSectionPlace[]): RollMarker[] => {
  const seen = new Map<string, number>();
  return sanitizeRollMarkers(
    sections.map((s, i) => {
      const count = (seen.get(s.label) ?? 0) + 1;
      seen.set(s.label, count);
      return { id: `form-${i}`, step: s.step, name: count > 1 ? `${s.label} ${count}` : s.label, kind: 'section' as const, origin: 'form' as const };
    }),
  );
};

/**
 * The roll's markers after a song build: every marker the user made, and
 * `form` in place of the ones the previous build wrote. A FORM marker the user
 * renamed, moved or retyped keeps its id and is the user's now, so it claims
 * its section: the build writes no second marker for that section. A user
 * marker at the tick of a new FORM marker of its kind wins that place too.
 */
export const withFormMarkers = (markers: readonly RollMarker[], form: readonly RollMarker[]): RollMarker[] => {
  const own = markers.filter((m) => m.origin !== 'form');
  const claimed = new Set(own.map((m) => m.id));
  const taken = new Set(own.map((m) => `${m.kind}@${m.tick}`));
  return sanitizeRollMarkers([...own, ...form.filter((m) => !claimed.has(m.id) && !taken.has(`${m.kind}@${m.tick}`))]);
};

/** The markers without the ones FORM wrote (RESET after a song). */
export const withoutFormMarkers = (markers: readonly RollMarker[]): RollMarker[] => markers.filter((m) => m.origin !== 'form');

// ── EDIT's timeline ──────────────────────────────────────────────────────────

/** The id of the EDIT marker a roll clip's marker becomes. */
export const editMarkerId = (clipId: string, markerId: string): string => `${ROLL_EDIT_MARKER_PREFIX}${clipId}:${markerId}`;

/** True when an EDIT marker was written by the roll clip `clipId`. */
export const isClipEditMarker = (m: Pick<TimelineMarker, 'id'>, clipId: string): boolean => m.id.startsWith(`${ROLL_EDIT_MARKER_PREFIX}${clipId}:`);

/** Where a roll clip sits on EDIT's timeline, and the clock its notes play through. */
export interface ClipMarkerPlacement {
  clipId: string;
  /** The clip's left edge on the timeline, in seconds. */
  startSec: number;
  /** The clip's trim into its source, in seconds. */
  offsetSec: number;
  /** The clip's length on the timeline, in seconds. */
  durationSec: number;
  /** The clip's tempo (`sourceBpm`) and map (`sourceTempoMap`), which time its steps. */
  bpm: number;
  tempoMap?: readonly TempoEvent[] | null;
}

/**
 * The EDIT timeline markers a roll clip's markers make: each at the second its
 * step sounds in the clip (through the clip's tempo map, so a marker after a
 * ritardando lands where the music does), labelled with its name. A marker
 * outside the clip's visible span is left out.
 */
export const clipTimelineMarkers = (markers: readonly RollMarker[], at: ClipMarkerPlacement): TimelineMarker[] => {
  const clock = stepClock(at.bpm, at.tempoMap);
  const out: TimelineMarker[] = [];
  const eps = 1e-6;
  for (const m of markers) {
    const rel = clock.at(markerStep(m)) - at.offsetSec;
    if (rel < -eps || rel > at.durationSec + eps) continue;
    out.push({ id: editMarkerId(at.clipId, m.id), t: Math.max(0, at.startSec + Math.max(0, rel)), label: m.name });
  }
  return out;
};

/** EDIT's markers with the clip's own replaced by `incoming`, sorted by time. Every other marker keeps its object. */
export const withClipTimelineMarkers = (
  existing: readonly TimelineMarker[],
  clipId: string,
  incoming: readonly TimelineMarker[],
): TimelineMarker[] => [...existing.filter((m) => !isClipEditMarker(m, clipId)), ...incoming].sort((a, b) => a.t - b.t);

/**
 * The timeline second a clip's source starts on: its left edge less its trim,
 * the trim counted in timeline seconds at the clip's stretch rate. A move or a
 * slip changes it and the markers written from the clip's notes move with it;
 * a trim of the left edge moves the edge and the trim together and leaves it.
 */
export const clipContentOrigin = (clip: { startSec: number; offsetIntoSource: number }, rate = 1): number =>
  clip.startSec - clip.offsetIntoSource / (Number.isFinite(rate) && rate > 0 ? rate : 1);

/**
 * EDIT's markers with the ones clip `clipId` wrote moved by `shiftSec` (the
 * clip moved or slipped on the timeline), sorted by time; the same array when
 * there is nothing to move. Every other marker keeps its object.
 */
export const shiftClipTimelineMarkers = (existing: readonly TimelineMarker[], clipId: string, shiftSec: number): readonly TimelineMarker[] => {
  if (!Number.isFinite(shiftSec) || Math.abs(shiftSec) < 1e-9 || !existing.some((m) => isClipEditMarker(m, clipId))) return existing;
  return existing
    .map((m) => (isClipEditMarker(m, clipId) ? { ...m, t: Math.max(0, m.t + shiftSec) } : m))
    .sort((a, b) => a.t - b.t);
};

/**
 * EDIT's markers after clip `clipId` is split at `atSec` into itself and
 * `rightId`: a marker the clip wrote at or past the seam now belongs to the
 * right half (its id names `rightId`), so each half moves, and re-bounces,
 * with the notes it holds. The same array when no marker changes hands.
 */
export const splitClipTimelineMarkers = (
  existing: readonly TimelineMarker[],
  clipId: string,
  rightId: string,
  atSec: number,
): readonly TimelineMarker[] => {
  const own = `${ROLL_EDIT_MARKER_PREFIX}${clipId}:`;
  if (!existing.some((m) => m.id.startsWith(own) && m.t >= atSec - 1e-9)) return existing;
  return existing.map((m) => (m.id.startsWith(own) && m.t >= atSec - 1e-9 ? { ...m, id: editMarkerId(rightId, m.id.slice(own.length)) } : m));
};

// ── .tasmo ───────────────────────────────────────────────────────────────────

/** A marker as a .tasmo clip stores it (`roll_markers`): `origin` only on a FORM marker. */
export interface TasmoRollMarker {
  id: string;
  tick: number;
  name: string;
  kind: RollMarkerKind;
  origin?: 'form';
}

export const rollMarkerToTasmo = (m: RollMarker): TasmoRollMarker => ({
  id: m.id,
  tick: m.tick,
  name: m.name,
  kind: m.kind,
  ...(m.origin ? { origin: m.origin } : {}),
});

/** The markers a .tasmo clip's `roll_markers` holds; junk entries are left out (sanitizeRollMarkers). */
export const tasmoToRollMarkers = (raw: unknown): RollMarker[] =>
  Array.isArray(raw) ? sanitizeRollMarkers(raw.filter((m): m is RollMarkerInput => !!m && typeof m === 'object')) : [];
