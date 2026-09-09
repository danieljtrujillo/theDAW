/**
 * lyricAnalysisStore - the literary analysis of the SING tab's lyrics.
 *
 * One entry at a time, the same shape as lyricsStore: `load(entryId)` fetches
 * the stored document (and joins an analysis already running for it), `run()`
 * starts a fresh pass and polls its job into `job`, `clear()` drops everything.
 * The view preferences — which device families are painted, the confidence
 * floor, whether the karaoke overlay is on, whether the sheet draws its rhyme
 * links and stress rows, and the LLM provider/model — live in localStorage
 * under `lyricAnalysis.*`; everything else is session state.
 *
 * The second half of this module is the pure view-model the pane draws: the
 * word-level index the karaoke paints from, and the character-level sheet
 * model (`buildSheetModel`, `rhymeLanes`) the STUDY pane and the standalone
 * writing surface both render.
 */
import { create } from 'zustand';
import {
  deleteLyricAnalysis,
  fetchActiveLyricAnalysisJob,
  fetchLyricAnalysis,
  fetchLyricAnalysisCapability,
  pollLyricAnalysisJob,
  startLyricAnalysis,
  type Device,
  type DeviceFamily,
  type LineMetrics,
  type LyricAnalysisDoc,
  type LyricAnalysisJobStatus,
  type RunOptions,
  type Span,
} from '../lib/lyricAnalysisClient';

export const DEVICE_FAMILIES: DeviceFamily[] = ['rhyme', 'sound', 'repetition', 'structure', 'meaning'];

export const FAMILY_LABELS: Record<DeviceFamily, string> = {
  rhyme: 'RHYME',
  sound: 'SOUND',
  repetition: 'REPETITION',
  structure: 'STRUCTURE',
  meaning: 'MEANING',
};

/** One word can carry several devices; the overlay paints the first family in
 *  this order, so the rhyme scheme is never hidden under an alliteration. */
const FAMILY_PRIORITY: DeviceFamily[] = ['rhyme', 'repetition', 'sound', 'structure', 'meaning'];

export type FamilyVisibility = Record<DeviceFamily, boolean>;

export interface LyricAnalysisJobState {
  id: string;
  status: LyricAnalysisJobStatus;
  message: string;
  progress: number;
}

const KEY_FAMILIES = 'lyricAnalysis.families';
const KEY_MIN_CONFIDENCE = 'lyricAnalysis.minConfidence';
const KEY_OVERLAY = 'lyricAnalysis.overlay';
const KEY_LINKS = 'lyricAnalysis.links';
const KEY_STRESS = 'lyricAnalysis.stress';
const KEY_PROVIDER = 'lyricAnalysis.provider';
const KEY_MODEL = 'lyricAnalysis.model';

const readBool = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const readNumber = (key: string, fallback: number): number => {
  try {
    const raw = localStorage.getItem(key);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const readString = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
};

/** `sound` starts OFF: alliteration, assonance and consonance fire on most of
 *  a lyric by their nature (measured: 78% of words carry a mark with every
 *  family on, 48% without sound), which reads as a highlighter accident rather
 *  than a finding. The family toggle turns it back on for a sound pass. */
const DEFAULT_FAMILIES = (): FamilyVisibility =>
  Object.fromEntries(DEVICE_FAMILIES.map((f) => [f, f !== 'sound'])) as FamilyVisibility;

const readFamilies = (): FamilyVisibility => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY_FAMILIES);
  } catch {
    return DEFAULT_FAMILIES();
  }
  if (raw === null) return DEFAULT_FAMILIES();
  const on = new Set(raw.split(',').filter(Boolean));
  return Object.fromEntries(DEVICE_FAMILIES.map((f) => [f, on.has(f)])) as FamilyVisibility;
};

/** The backend types `family` as a plain string; anything unknown is dropped
 *  rather than painted with no colour. */
export const asFamily = (family: string): DeviceFamily | null =>
  (DEVICE_FAMILIES as string[]).includes(family) ? (family as DeviceFamily) : null;

/** The findings the current filters let through, strongest first. */
export function visibleDevices(
  doc: LyricAnalysisDoc | null,
  families: FamilyVisibility,
  minConfidence: number,
): Device[] {
  if (!doc) return [];
  return doc.devices
    .filter((d) => {
      const fam = asFamily(d.family);
      return fam !== null && families[fam] && d.confidence >= minConfidence;
    })
    .sort((a, b) => b.confidence - a.confidence);
}

export interface WordDeviceMark {
  family: DeviceFamily;
  /** Every group touching this word, so the selected finding can light up. */
  groups: string[];
  /** Tooltip text: the labels of the devices on this word, capped. */
  title: string;
  /** Confidence of the device that won the word, so a 0.6 slant rhyme paints
   *  fainter than a 1.0 perfect one instead of looking just as certain. */
  confidence: number;
}

export const wordMarkKey = (line: number, word: number): string => `${line}:${word}`;

/** A dense lyric puts six or more findings on one word, and a label naming
 *  every span of a 400-line refrain runs to thousands of characters. A native
 *  tooltip has to stay readable, so both are clipped. */
const TITLE_MAX_LABELS = 4;
const TITLE_MAX_LABEL_CHARS = 80;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Word -> device mark, keyed `line:word`. Built once per render in the
 * scroller (never inside its per-frame position loop), so painting a device is
 * just one more data attribute on a span that already exists.
 *
 * The mark is per WORD, not per span: `span.char_start` / `char_end` are
 * deliberately ignored here. A span may cover only part of a word (an
 * alliteration is anchored to the initial consonant alone, an assonance to the
 * stressed syllable), but the karaoke word is one element carrying a gradient
 * clipped to its glyphs — splitting it would break the fill — so the whole
 * word wears the underline. Read the pane's findings list for the exact
 * stretch a device claims.
 */
export function buildWordDeviceIndex(
  doc: LyricAnalysisDoc | null,
  families: FamilyVisibility,
  minConfidence: number,
): Map<string, WordDeviceMark> {
  const marks = new Map<string, WordDeviceMark>();
  for (const device of visibleDevices(doc, families, minConfidence)) {
    const family = asFamily(device.family);
    if (!family) continue;
    const group = device.group || device.id;
    const label = clip(device.label, TITLE_MAX_LABEL_CHARS);
    for (const span of device.spans) {
      if (span.line < 0 || span.word < 0) continue;
      const key = wordMarkKey(span.line, span.word);
      const prev = marks.get(key);
      if (!prev) {
        marks.set(key, { family, groups: [group], title: label, confidence: device.confidence });
        continue;
      }
      if (!prev.groups.includes(group)) {
        prev.groups.push(group);
        if (prev.groups.length <= TITLE_MAX_LABELS) prev.title = `${prev.title} · ${label}`;
      }
      // The painted family wins the word, so the strength shown is ITS strength,
      // not the strongest of everything that happens to touch the word.
      if (FAMILY_PRIORITY.indexOf(family) < FAMILY_PRIORITY.indexOf(prev.family)) {
        prev.family = family;
        prev.confidence = device.confidence;
      } else if (family === prev.family && device.confidence > prev.confidence) {
        prev.confidence = device.confidence;
      }
    }
  }
  for (const mark of marks.values()) {
    const hidden = mark.groups.length - TITLE_MAX_LABELS;
    if (hidden > 0) mark.title = `${mark.title} · +${hidden} more`;
  }
  return marks;
}

// --- the annotated sheet ---------------------------------------------------
//
// The pane's centrepiece is the lyric itself with the findings drawn ON it, so
// everything below turns (analysis, words) into something a renderer can walk:
// each line cut at every device boundary, the rhyme classes as spans that can
// be bracketed in a gutter, and the pairs that only make sense as a drawn link.
// All pure and memoised by the caller — none of it may ever run per frame.

export type RhymePattern = 'solid' | 'dashed' | 'dotted' | 'double';

export interface RhymeInk {
  index: number;
  rgb: string;
  /** Stroke of the class spine in the gutter. */
  pattern: RhymePattern;
  /** 0-7: the marker drawn at every member of the class. Two classes never
   *  differ by hue alone — the shape separates the first eight classes, the
   *  spine pattern the next twenty-four, and the letter always says it out. */
  shape: number;
}

const RHYME_HUES = [
  '251 113 133', // rose
  '56 189 248', // sky
  '52 211 153', // emerald
  '232 121 249', // fuchsia
  '251 191 36', // amber
  '167 139 250', // violet
  '45 212 191', // teal
  '244 114 182', // pink
];
const RHYME_PATTERNS: RhymePattern[] = ['solid', 'dashed', 'dotted', 'double'];
export const RHYME_SHAPES = 8;

/** The colours sing.css paints each family in, so a canvas or an inline style
 *  can match the stylesheet without duplicating the numbers by hand. */
export const FAMILY_RGB: Record<DeviceFamily, string> = {
  rhyme: '251 113 133',
  sound: '56 189 248',
  repetition: '167 139 250',
  structure: '52 211 153',
  meaning: '232 121 249',
};

/** Scheme letters run A..Z then AA, AB ...: base 26 with no zero digit. */
export const letterIndex = (letter: string): number => {
  const t = letter.trim().toUpperCase();
  if (!t) return -1;
  let idx = 0;
  for (const ch of t) {
    const c = ch.charCodeAt(0) - 65;
    if (c < 0 || c > 25) return -1;
    idx = idx * 26 + c + 1;
  }
  return idx - 1;
};

/** The ink for the Nth rhyme class of the lyric. */
export const inkAt = (index: number): RhymeInk | null => {
  if (!Number.isInteger(index) || index < 0) return null;
  return {
    index,
    rgb: RHYME_HUES[index % RHYME_HUES.length],
    pattern: RHYME_PATTERNS[Math.floor(index / RHYME_HUES.length) % RHYME_PATTERNS.length],
    shape: index % RHYME_SHAPES,
  };
};

/**
 * Ink for a scheme LETTER.
 *
 * Only correct where the letters are unique across the whole lyric. The sheet
 * does NOT use it, because the backend letters the scheme per section: the "A"
 * of the chorus is a different rhyme from the "A" of verse 1, and inking both
 * rose would say the ten lines rhyme with each other when only pairs inside
 * each section do. `buildSheetModel` numbers the classes by the sound they end
 * on (`SheetRow.classIndex`) and the sheet inks from that.
 */
export const rhymeInk = (letter: string): RhymeInk | null => inkAt(letterIndex(letter));

const hashIndex = (s: string, n: number): number => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
};

/** Ink for a device that belongs to no scheme class — an internal rhyme, an
 *  echo across two lines. Stable per group, so the same pair keeps its colour
 *  and its dash between renders. */
export const groupInk = (group: string): { rgb: string; dash: string } => {
  const h = hashIndex(group || 'x', RHYME_HUES.length * 4);
  return {
    rgb: RHYME_HUES[h % RHYME_HUES.length],
    dash: ['', '5 3', '1 3', '7 2 1 2'][Math.floor(h / RHYME_HUES.length) % 4],
  };
};

/** The words the sheet draws. `LyricsDoc` satisfies this, and so does
 *  `{ lines: splitText(text) }` for a lyric that has never been saved — but
 *  the words MUST be the ones the analysis was computed from, because every
 *  finding is anchored by word index. */
export interface SheetWordSource {
  text: string;
}
export interface SheetLineSource {
  text: string;
  kind: 'lyric' | 'marker';
  words: SheetWordSource[];
}
export interface SheetSource {
  lines: SheetLineSource[];
}

export interface SheetSegment {
  /** Offsets into the row's flat text, so a device can claim "ele|VATION". */
  start: number;
  end: number;
  text: string;
  family: DeviceFamily | null;
  deviceId: string;
  group: string;
  /** Every group covering this stretch, for the selected-finding highlight. */
  groups: string[];
  confidence: number;
  /** The scheme class, when this stretch is the line's rhyming ending. */
  letter: string;
  /** The class's number in the lyric, for its ink; -1 when it wears none. */
  classIndex: number;
  /** How many findings are stacked here: the sheet tints the busy stretches. */
  stack: number;
  title: string;
}

export interface SheetRow {
  line: number;
  kind: 'lyric' | 'marker';
  blank: boolean;
  text: string;
  segments: SheetSegment[];
  letter: string;
  /** What actually makes two lines one class: the sound they end on. The
   *  scheme letters are lettered PER SECTION, so the letter alone is not an
   *  identity — see `classIndex`. Empty when the line ends on no rhyme. */
  classKey: string;
  /** The class's number in the lyric (first appearance order), which is what
   *  the gutter, the badge and the chips take their hue and shape from. -1
   *  when the line ends on no rhyme. */
  classIndex: number;
  endKey: string;
  syllables: number;
  stress: string;
  words: number;
  devices: number;
  /** Families present on the line, strongest first — the density strip's ink. */
  families: DeviceFamily[];
  section: string;
}

export interface SheetLinkEnd {
  line: number;
  start: number;
  end: number;
  text: string;
}

export interface SheetLink {
  id: string;
  deviceId: string;
  group: string;
  kind: string;
  label: string;
  family: DeviceFamily;
  rgb: string;
  dash: string;
  confidence: number;
  a: SheetLinkEnd;
  b: SheetLinkEnd;
}

export interface SheetModel {
  rows: SheetRow[];
  links: SheetLink[];
  /** Links found but not drawn: the layer is capped so a refrain repeated
   *  forty times cannot bury the words under its own wiring. */
  linkOverflow: number;
  maxDevices: number;
  maxSyllables: number;
}

/** The kinds that are invisible in a list and obvious as a drawn arc: a rhyme
 *  buried mid-line, one that answers a word in the line before, a word handed
 *  from the end of a line to the start of the next. */
const LINK_KINDS = new Set([
  'internal-rhyme',
  'leonine-rhyme',
  'cross-line-rhyme',
  'multisyllabic-rhyme',
  'identical-rhyme',
  'anadiplosis',
  'epizeuxis',
  'polyptoton',
  'antimetabole',
]);

const MAX_LINKS = 140;
const SEGMENT_TITLE_LABELS = 3;

interface FlatLine {
  text: string;
  starts: number[];
  ends: number[];
}

/** The line as one string, plus where each word landed in it. The sheet draws
 *  from the WORDS, not from `line.text`, because that is what the findings are
 *  anchored to — same tokens as the karaoke, same indices. */
const flatten = (words: SheetWordSource[]): FlatLine => {
  const starts: number[] = [];
  const ends: number[] = [];
  let text = '';
  for (const w of words) {
    if (text) text += ' ';
    starts.push(text.length);
    text += w.text ?? '';
    ends.push(text.length);
  }
  return { text, starts, ends };
};

/** A span's stretch of the flat line, or null when it points at nothing: the
 *  offsets are clamped to the word, because a stale analysis can name a word
 *  that has since been shortened. */
const spanRange = (flat: FlatLine, span: Span): [number, number] | null => {
  const from = flat.starts[span.word];
  const to = flat.ends[span.word];
  if (from === undefined || to === undefined) return null;
  const len = to - from;
  const cs = Math.max(0, Math.min(len, span.char_start || 0));
  const rawEnd = span.char_end === null || span.char_end === undefined ? len : span.char_end;
  const ce = Math.max(cs, Math.min(len, rawEnd));
  return ce > cs ? [from + cs, from + ce] : null;
};

const strongest = (devices: Device[]): Device => {
  let best = devices[0];
  for (const d of devices) {
    const bf = FAMILY_PRIORITY.indexOf(asFamily(best.family) ?? 'meaning');
    const df = FAMILY_PRIORITY.indexOf(asFamily(d.family) ?? 'meaning');
    if (df < bf || (df === bf && d.confidence > best.confidence)) best = d;
  }
  return best;
};

/**
 * The whole sheet: one row per line of the lyric, each cut into segments at
 * every device boundary, plus the links worth drawing. With no words to hand
 * (an analysis loaded before SING has), the rows still carry the scheme
 * letters and the numbers, so the shape of the lyric reads anyway.
 */
export function buildSheetModel(
  doc: LyricAnalysisDoc | null,
  source: SheetSource | null,
  families: FamilyVisibility,
  minConfidence: number,
): SheetModel {
  const empty: SheetModel = { rows: [], links: [], linkOverflow: 0, maxDevices: 0, maxSyllables: 0 };
  if (!doc) return empty;

  const metrics = new Map<number, LineMetrics>();
  for (const m of doc.lines) metrics.set(m.line, m);

  const shown = visibleDevices(doc, families, minConfidence);
  const byLine = new Map<number, Device[]>();
  for (const d of shown) {
    for (const line of new Set(d.spans.map((s) => s.line))) {
      const list = byLine.get(line);
      if (list) list.push(d);
      else byLine.set(line, [d]);
    }
  }

  const srcLines = source?.lines ?? [];
  const analysed = doc.lines.length ? Math.max(...doc.lines.map((l) => l.line)) + 1 : 0;
  const lineCount = srcLines.length || analysed;

  // Number the rhyme classes for the whole lyric, in reading order, by the
  // SOUND each ends on. The backend letters the scheme per section, so "A" in
  // the chorus is not "A" in verse 1 — inking both from the letter painted ten
  // lines of four different rhymes in one colour and one shape, and isolating
  // the class lit all ten. `end_key` is the real identity: two lines are one
  // class exactly when they end on the same phones, wherever they sit. A lyric
  // with one section is unaffected — its A is still the first class, in rose.
  const classIndexOf = new Map<string, number>();
  const classKeyOf = (m: LineMetrics | null): string => {
    if (!m || !m.letter) return '';
    // With no ending recorded, fall back to the letter WITHIN its section, so
    // two sections' "A" still cannot be merged by accident.
    return m.end_key ? `k:${m.end_key}` : `s:${m.section}|${m.letter}`;
  };
  for (let i = 0; i < lineCount; i += 1) {
    const key = classKeyOf(metrics.get(i) ?? null);
    if (key && !classIndexOf.has(key)) classIndexOf.set(key, classIndexOf.size);
  }

  const flats = new Map<number, FlatLine>();
  const rows: SheetRow[] = [];
  let maxDevices = 0;
  let maxSyllables = 0;

  for (let i = 0; i < lineCount; i += 1) {
    const src = srcLines[i] ?? null;
    const m = metrics.get(i) ?? null;
    const words = src?.words ?? [];
    const flat = flatten(words);
    flats.set(i, flat);
    const text = flat.text || src?.text || '';
    const kind: 'lyric' | 'marker' = src?.kind ?? 'lyric';
    const devices = byLine.get(i) ?? [];
    const classKey = classKeyOf(m);
    const classIndex = classKey ? classIndexOf.get(classKey) ?? -1 : -1;

    // Cut the line wherever a finding starts or stops, then hand each piece the
    // findings that cover the whole of it.
    const covers: Array<{ device: Device; range: [number, number] }> = [];
    const cuts = new Set<number>([0, text.length]);
    for (const d of devices) {
      for (const sp of d.spans) {
        if (sp.line !== i) continue;
        const range = spanRange(flat, sp);
        if (!range) continue;
        covers.push({ device: d, range });
        cuts.add(range[0]);
        cuts.add(range[1]);
      }
    }

    // The line's rhyming ending: the run of final words a rhyme finding claims.
    // That is what wears the scheme class's colour, so "ele|VATION" is painted
    // as class B and the rest of the line is not.
    let tailStart = text.length;
    for (let j = words.length - 1; j >= 0; j -= 1) {
      const ws = flat.starts[j];
      const we = flat.ends[j];
      const rhymed = covers.some(
        (c) => asFamily(c.device.family) === 'rhyme' && c.range[0] < we && c.range[1] > ws,
      );
      if (!rhymed) break;
      tailStart = ws;
    }

    const bounds = Array.from(cuts).sort((a, b) => a - b);
    const segments: SheetSegment[] = [];
    for (let k = 0; k < bounds.length - 1; k += 1) {
      const start = bounds[k];
      const end = bounds[k + 1];
      if (end <= start) continue;
      const here = covers.filter((c) => c.range[0] <= start && c.range[1] >= end).map((c) => c.device);
      if (!here.length) {
        segments.push({
          start,
          end,
          text: text.slice(start, end),
          family: null,
          deviceId: '',
          group: '',
          groups: [],
          confidence: 0,
          letter: '',
          classIndex: -1,
          stack: 0,
          title: '',
        });
        continue;
      }
      const top = strongest(here);
      const family = asFamily(top.family);
      const groups = Array.from(new Set(here.map((d) => d.group || d.id)));
      segments.push({
        start,
        end,
        text: text.slice(start, end),
        family,
        deviceId: top.id,
        group: top.group || top.id,
        groups,
        confidence: top.confidence,
        letter: family === 'rhyme' && start >= tailStart ? m?.letter ?? '' : '',
        classIndex: family === 'rhyme' && start >= tailStart ? classIndex : -1,
        stack: here.length,
        title: here
          .slice(0, SEGMENT_TITLE_LABELS)
          .map((d) => `${d.kind.replace(/-/g, ' ')}: ${clip(d.label, TITLE_MAX_LABEL_CHARS)}`)
          .concat(here.length > SEGMENT_TITLE_LABELS ? [`+${here.length - SEGMENT_TITLE_LABELS} more`] : [])
          .join(' · '),
      });
    }

    const present = new Set<DeviceFamily>();
    for (const d of devices) {
      const f = asFamily(d.family);
      if (f) present.add(f);
    }
    maxDevices = Math.max(maxDevices, devices.length);
    maxSyllables = Math.max(maxSyllables, m?.syllables ?? 0);
    rows.push({
      line: i,
      kind,
      blank: !text.trim(),
      text,
      segments,
      letter: m?.letter ?? '',
      classKey,
      classIndex,
      endKey: m?.end_key ?? '',
      syllables: m?.syllables ?? 0,
      stress: m?.stress ?? '',
      words: words.length || m?.words || 0,
      devices: devices.length,
      families: FAMILY_PRIORITY.filter((f) => present.has(f)),
      section: m?.section ?? '',
    });
  }

  // Links come last: both ends need their line flattened first.
  const links: SheetLink[] = [];
  let linkOverflow = 0;
  for (const d of shown) {
    if (!LINK_KINDS.has(d.kind)) continue;
    const family = asFamily(d.family);
    if (!family) continue;
    const ends: SheetLinkEnd[] = [];
    for (const sp of d.spans) {
      const flat = flats.get(sp.line);
      if (!flat) continue;
      const range = spanRange(flat, sp);
      if (!range) continue;
      ends.push({ line: sp.line, start: range[0], end: range[1], text: flat.text.slice(range[0], range[1]) });
    }
    const ink = groupInk(d.group || d.id);
    for (let k = 1; k < ends.length; k += 1) {
      if (links.length >= MAX_LINKS) {
        linkOverflow += 1;
        continue;
      }
      links.push({
        id: `${d.id}:${k}`,
        deviceId: d.id,
        group: d.group || d.id,
        kind: d.kind,
        label: d.label,
        family,
        rgb: ink.rgb,
        dash: ink.dash,
        confidence: d.confidence,
        a: ends[k - 1],
        b: ends[k],
      });
    }
  }

  return { rows, links, linkOverflow, maxDevices, maxSyllables };
}

export type LaneState = 'through' | 'start' | 'mid' | 'end';

export interface LaneCell {
  letter: string;
  /** The class this bracket belongs to, for its ink and for isolating it. */
  classKey: string;
  classIndex: number;
  state: LaneState;
}

export interface RhymeLanes {
  lanes: number;
  /** Row index (not line number) -> one cell per lane, null where the lane is
   *  empty on that row. */
  cells: Map<number, Array<LaneCell | null>>;
}

/**
 * The gutter's rhyme spines: each class becomes a bracket running from its
 * first member to its last, and overlapping classes are pushed into their own
 * lane so their brackets never sit on top of each other. Rows are indexed
 * positionally, so the bracket stays continuous through markers and blanks.
 *
 * Classes are `row.classKey` (the sound the line ends on), never the scheme
 * letter — the letters are read per section, so an "A" in the chorus is not
 * the "A" of the first verse and must not be bracketed to it. Still called per
 * section, so a rhyme that comes back two verses later gets its own bracket
 * there rather than one spine down the whole song.
 */
export function rhymeLanes(rows: SheetRow[], maxLanes = 5): RhymeLanes {
  const members = new Map<string, number[]>();
  const letterOf = new Map<string, string>();
  const indexOf = new Map<string, number>();
  rows.forEach((row, idx) => {
    // Bracket by CLASS, not by letter: two sections both lettered "A" are two
    // different rhymes and must never be joined into one spine.
    if (!row.classKey) return;
    const list = members.get(row.classKey);
    if (list) list.push(idx);
    else {
      members.set(row.classKey, [idx]);
      letterOf.set(row.classKey, row.letter);
      indexOf.set(row.classKey, row.classIndex);
    }
  });

  // A class with one member has nothing to connect: it keeps its badge and
  // costs no lane.
  const spans = Array.from(members.entries())
    .filter(([, idxs]) => idxs.length > 1)
    .map(([key, idxs]) => ({
      key,
      letter: letterOf.get(key) ?? '',
      classIndex: indexOf.get(key) ?? -1,
      idxs,
      start: idxs[0],
      end: idxs[idxs.length - 1],
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const cells = new Map<number, Array<LaneCell | null>>();
  const laneEnds: number[] = [];
  let lanes = 0;
  for (const span of spans) {
    let lane = laneEnds.findIndex((end) => end < span.start);
    if (lane < 0) {
      if (laneEnds.length < maxLanes) {
        lane = laneEnds.length;
        laneEnds.push(span.end);
      } else {
        // Past the cap the brackets share the last lane; they still read,
        // because the letter and the node shape are on every member.
        lane = maxLanes - 1;
        laneEnds[lane] = Math.max(laneEnds[lane], span.end);
      }
    } else {
      laneEnds[lane] = span.end;
    }
    lanes = Math.max(lanes, lane + 1);
    const memberAt = new Set(span.idxs);
    for (let row = span.start; row <= span.end; row += 1) {
      const laneRow = cells.get(row) ?? [];
      const state: LaneState = !memberAt.has(row)
        ? 'through'
        : row === span.start
          ? 'start'
          : row === span.end
            ? 'end'
            : 'mid';
      // Two classes in one lane can only collide past the cap; first wins.
      if (!laneRow[lane]) {
        laneRow[lane] = {
          letter: span.letter,
          classKey: span.key,
          classIndex: span.classIndex,
          state,
        };
      }
      cells.set(row, laneRow);
    }
  }
  return { lanes, cells };
}

export interface LyricAnalysisState {
  entryId: string | null;
  doc: LyricAnalysisDoc | null;
  persisted: boolean;
  /** The lyrics changed under this analysis: the findings no longer line up. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  job: LyricAnalysisJobState | null;
  /** Empty until the capability probe answers; then the providers it accepts. */
  providers: string[];
  llmAvailable: boolean;
  probed: boolean;

  families: FamilyVisibility;
  minConfidence: number;
  overlay: boolean;
  /** Draw internal / cross-line rhymes as arcs over the sheet. */
  links: boolean;
  /** Show the per-line stress pattern beside the sheet. */
  stress: boolean;
  /** The device group the findings list has selected; the karaoke lights it up. */
  selectedGroup: string | null;
  /** The one finding being inspected: its spans, phones and reason. Always in
   *  the selected group, but a group can hold several findings. */
  selectedDeviceId: string | null;
  llm: boolean;
  provider: string;
  model: string;

  load: (entryId: string) => Promise<void>;
  run: (opts?: RunOptions) => Promise<void>;
  remove: () => Promise<void>;
  probe: () => Promise<void>;
  clear: () => void;
  setFamily: (family: DeviceFamily, on: boolean) => void;
  setMinConfidence: (v: number) => void;
  setOverlay: (on: boolean) => void;
  setLinks: (on: boolean) => void;
  setStress: (on: boolean) => void;
  setSelectedGroup: (group: string | null) => void;
  setSelectedDevice: (device: Device | null) => void;
  setLlm: (on: boolean) => void;
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  clearError: () => void;
}

// One generation counter so a slow load for the previous entry cannot land on
// top of the entry the user has since selected.
let loadGeneration = 0;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useLyricAnalysisStore = create<LyricAnalysisState>()((set, get) => {
  /**
   * Still on the entry (and the load) this work began for? The poller runs to
   * the job's end whatever the user does, so every write it makes has to ask
   * first: a job for the song they have since left must not push its progress,
   * its error or its result onto the song now on screen — and must not leave
   * `job` set, which would block ANALYSE for the new one.
   */
  const stillCurrent = (entryId: string, generation: number): boolean =>
    generation === loadGeneration && get().entryId === entryId;

  /** Follow a job to its end; returns the analysis it produced, or null. */
  const trackJob = async (
    entryId: string,
    generation: number,
    jobId: string,
  ): Promise<LyricAnalysisDoc | null> => {
    if (!stillCurrent(entryId, generation)) return null;
    set({ job: { id: jobId, status: 'queued', message: 'queued', progress: 0 } });
    const job = await pollLyricAnalysisJob(jobId, (j) => {
      if (!stillCurrent(entryId, generation)) return;
      set({ job: { id: j.id, status: j.status, message: j.message, progress: j.progress } });
    });
    if (!stillCurrent(entryId, generation)) return null;
    if (job.status !== 'done') {
      set({ error: job.error || job.message || 'analysis failed', job: null });
      return null;
    }
    set({ job: null });
    return job.result;
  };

  const landResult = (
    entryId: string,
    generation: number,
    doc: LyricAnalysisDoc | null,
  ): void => {
    if (!doc || !stillCurrent(entryId, generation)) return;
    set({ doc, persisted: true, stale: false, error: null });
  };

  return {
    entryId: null,
    doc: null,
    persisted: false,
    stale: false,
    loading: false,
    error: null,
    job: null,
    providers: [],
    llmAvailable: false,
    probed: false,

    families: readFamilies(),
    minConfidence: readNumber(KEY_MIN_CONFIDENCE, 0.5),
    overlay: readBool(KEY_OVERLAY, true),
    links: readBool(KEY_LINKS, true),
    stress: readBool(KEY_STRESS, false),
    selectedGroup: null,
    selectedDeviceId: null,
    // The interpretive pass costs a call to a provider, so it never turns
    // itself on: the checkbox starts off every session.
    llm: false,
    provider: readString(KEY_PROVIDER, ''),
    model: readString(KEY_MODEL, ''),

    load: async (entryId) => {
      const generation = ++loadGeneration;
      set({ entryId, loading: true, error: null, job: null, selectedGroup: null, selectedDeviceId: null });
      try {
        const bundle = await fetchLyricAnalysis(entryId);
        if (generation !== loadGeneration) return;
        set({
          doc: bundle.doc,
          persisted: bundle.persisted,
          stale: bundle.stale,
          loading: false,
        });
      } catch (e) {
        if (generation !== loadGeneration) return;
        set({ doc: null, persisted: false, stale: false, loading: false, error: errorMessage(e) });
        return;
      }
      // An analysis started before the pane opened keeps running server-side.
      const running = await fetchActiveLyricAnalysisJob(entryId);
      if (running && generation === loadGeneration && !get().job) {
        landResult(entryId, generation, await trackJob(entryId, generation, running.id));
      }
    },

    run: async (opts = {}) => {
      const { entryId, job, llm, provider, model } = get();
      if (!entryId || job) return;
      const generation = loadGeneration;
      set({ error: null, selectedGroup: null, selectedDeviceId: null });
      try {
        const started = await startLyricAnalysis(entryId, {
          force: opts.force ?? true,
          llm: opts.llm ?? llm,
          provider: opts.provider ?? provider,
          model: opts.model ?? model,
        });
        const jobId = started.job?.id;
        if (!jobId) {
          // No job came back: the analysis was already on disk and current.
          const bundle = await fetchLyricAnalysis(entryId);
          if (stillCurrent(entryId, generation)) {
            set({ doc: bundle.doc, persisted: bundle.persisted, stale: bundle.stale });
          }
          return;
        }
        landResult(entryId, generation, await trackJob(entryId, generation, jobId));
      } catch (e) {
        if (!stillCurrent(entryId, generation)) return;
        set({ error: errorMessage(e), job: null });
      }
    },

    remove: async () => {
      const { entryId } = get();
      if (!entryId) return;
      try {
        await deleteLyricAnalysis(entryId);
        if (get().entryId !== entryId) return;
        set({ doc: null, persisted: false, stale: false, selectedGroup: null, selectedDeviceId: null, error: null });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },

    probe: async () => {
      if (get().probed) return;
      try {
        const cap = await fetchLyricAnalysisCapability();
        // The capability payload is written by another module; keep only what
        // can actually go in an <option>.
        const providers = Array.isArray(cap.providers)
          ? cap.providers.filter((p): p is string => typeof p === 'string')
          : [];
        set({
          probed: true,
          llmAvailable: !!cap.llm_available,
          providers,
          provider: get().provider || providers[0] || '',
        });
      } catch {
        // The probe failed — usually the backend is not up yet. Do NOT latch
        // `probed`: latching it would disable the meaning pass for the whole
        // session over one refused connection. The next mount asks again.
        set({ probed: false, llmAvailable: false, providers: [] });
      }
    },

    clear: () => {
      // Bump the generation so a job still polling for the entry being dropped
      // cannot write its result back in after this.
      loadGeneration += 1;
      set({
        entryId: null,
        doc: null,
        persisted: false,
        stale: false,
        loading: false,
        error: null,
        job: null,
        selectedGroup: null,
        selectedDeviceId: null,
      });
    },

    setFamily: (family, on) => {
      const families = { ...get().families, [family]: on };
      set({ families });
      writeStorage(KEY_FAMILIES, DEVICE_FAMILIES.filter((f) => families[f]).join(','));
    },
    setMinConfidence: (v) => {
      const next = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
      set({ minConfidence: next });
      writeStorage(KEY_MIN_CONFIDENCE, String(next));
    },
    setOverlay: (on) => {
      set({ overlay: on });
      writeStorage(KEY_OVERLAY, on ? '1' : '0');
    },
    setLinks: (on) => {
      set({ links: on });
      writeStorage(KEY_LINKS, on ? '1' : '0');
    },
    setStress: (on) => {
      set({ stress: on });
      writeStorage(KEY_STRESS, on ? '1' : '0');
    },
    // Selecting a group without naming a finding closes the inspector: the
    // group is the paint, the device is the thing being read.
    setSelectedGroup: (group) => set({ selectedGroup: group, selectedDeviceId: null }),
    setSelectedDevice: (device) =>
      set(
        device
          ? { selectedDeviceId: device.id, selectedGroup: device.group || device.id }
          : { selectedDeviceId: null, selectedGroup: null },
      ),
    setLlm: (on) => set({ llm: on }),
    setProvider: (provider) => {
      set({ provider });
      writeStorage(KEY_PROVIDER, provider);
    },
    setModel: (model) => {
      set({ model });
      writeStorage(KEY_MODEL, model);
    },
    clearError: () => set({ error: null }),
  };
});
