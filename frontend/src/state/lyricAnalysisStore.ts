/**
 * lyricAnalysisStore - the literary analysis of the SING tab's lyrics.
 *
 * One entry at a time, the same shape as lyricsStore: `load(entryId)` fetches
 * the stored document (and joins an analysis already running for it), `run()`
 * starts a fresh pass and polls its job into `job`, `clear()` drops everything.
 * The view preferences — which device families are painted, the confidence
 * floor, whether the karaoke overlay and its wiring are on, how much of the
 * sheet's own wiring is drawn, the reading size and weight of the lyric,
 * whether the two panes are tied together, whether the sheet follows the
 * song, and the LLM provider/model — live in localStorage under
 * `lyricAnalysis.*`; everything else is session state.
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
  fetchLyricMarks,
  isMarkableDocId,
  isMarkDevice,
  pollLyricAnalysisJob,
  putLyricMarks,
  startLyricAnalysis,
  type Device,
  type DeviceFamily,
  type LineMetrics,
  type LyricAnalysisDoc,
  type LyricAnalysisJobStatus,
  type LyricMark,
  type LyricMarksBundle,
  type MarkVerdict,
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

/**
 * The rhyme kinds that describe a SHAPE rather than a pair: N consecutive
 * lines on one class, a class threaded through a whole verse, a class coming
 * back after a long gap, a section tied at both ends. A flat findings list
 * cannot express any of them — they are what the structure map draws.
 */
export const LONG_RANGE_KINDS: readonly string[] = [
  'rhyme-run',
  'rhyme-chain',
  'callback',
  'bookend',
];

/** A short code per long-range kind, so a band in the map is readable with no
 *  colour vision and no tooltip. */
export const LONG_RANGE_CODE: Record<string, string> = {
  'rhyme-run': 'RUN',
  'rhyme-chain': 'CHAIN',
  callback: 'CALL',
  bookend: 'ENDS',
};

/** What each one is, in a sentence, for the map's own legend. */
export const LONG_RANGE_BLURB: Record<string, string> = {
  'rhyme-run': 'consecutive lines all landing on one rhyme',
  'rhyme-chain': 'one rhyme threaded across a long stretch, gaps included',
  callback: 'a rhyme returning after a long gap, or in a later section',
  bookend: 'a section tied at both ends: its first line rhymes with its last',
};

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
/** The boolean this setting used to be. Read once, to migrate; never written. */
const KEY_LINKS_LEGACY = 'lyricAnalysis.links';
const KEY_LINK_MODE = 'lyricAnalysis.linkMode';
const KEY_STRESS = 'lyricAnalysis.stress';
const KEY_PROVIDER = 'lyricAnalysis.provider';
const KEY_MODEL = 'lyricAnalysis.model';
const KEY_MARK_MODE = 'lyricAnalysis.markMode';
const KEY_TEXT_SIZE = 'lyricAnalysis.textSize';
const KEY_TEXT_WEIGHT = 'lyricAnalysis.textWeight';
const KEY_MIRROR = 'lyricAnalysis.mirror';
const KEY_FOLLOW = 'lyricAnalysis.follow';
const KEY_KARAOKE_LINKS = 'lyricAnalysis.karaokeLinks';

/** How much of the wiring is drawn.
 *
 *  `near` is the resting state: only the links a reader would otherwise miss —
 *  an internal rhyme, an echo one line down — plus whatever finding is open.
 *  `all` is the whole web: every group with more than one place in it, rhyme
 *  classes included, wired end to end. It is deliberately a mode rather than
 *  the default, because on a dense lyric it draws several hundred strokes. */
export type LinkMode = 'off' | 'near' | 'all';

const LINK_MODES: readonly LinkMode[] = ['off', 'near', 'all'];

export const LINK_MODE_WORDS: Record<LinkMode, string> = {
  off: 'no wires',
  near: 'the wires a reader would otherwise miss, plus the finding you have open',
  all: 'every connection in the lyric, rhyme classes included',
};

/** The reading size of the sheet and of the writing surface, in px. Both
 *  surfaces read from the same number so the two panes never disagree. */
export const TEXT_SIZES = [11, 12, 13, 15, 17, 20] as const;
export const DEFAULT_TEXT_SIZE = 12;
/** Two weights, not a slider: a lyric is either set light or set heavy, and
 *  a 500 nobody can tell from a 400 is not worth a control. */
export const TEXT_WEIGHTS = [400, 600] as const;
export const DEFAULT_TEXT_WEIGHT = 400;

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

/** `sound` starts OFF: alliteration, assonance, consonance and the two density
 *  passes fire on most of a lyric by their nature, which reads as a highlighter
 *  accident rather than as a finding. Measured over the 14 lyric fixtures in
 *  `tests/test_lyricanalysis_devices.py` (985 words): 66% of words carry a mark
 *  with every family on, 35% with sound off. The family toggle turns it back on
 *  for a sound pass. */
const DEFAULT_FAMILIES = (): FamilyVisibility =>
  Object.fromEntries(DEVICE_FAMILIES.map((f) => [f, f !== 'sound'])) as FamilyVisibility;

const readLinkMode = (): LinkMode => {
  const raw = readString(KEY_LINK_MODE, '');
  if ((LINK_MODES as readonly string[]).includes(raw)) return raw as LinkMode;
  // No mode stored yet: honour whatever the older boolean was left at, so an
  // upgrade does not silently switch a writer's wiring back on.
  return readBool(KEY_LINKS_LEGACY, true) ? 'near' : 'off';
};

/** The nearest step on the size ladder, so a stored value from an older build
 *  (or a hand-edited one) still lands on a size the buttons can step from. */
export const nearestSize = (px: number): number => {
  if (!Number.isFinite(px)) return DEFAULT_TEXT_SIZE;
  let best = TEXT_SIZES[0] as number;
  for (const size of TEXT_SIZES) if (Math.abs(size - px) < Math.abs(best - px)) best = size;
  return best;
};

const readSize = (): number => nearestSize(readNumber(KEY_TEXT_SIZE, DEFAULT_TEXT_SIZE));

const readWeight = (): number =>
  readNumber(KEY_TEXT_WEIGHT, DEFAULT_TEXT_WEIGHT) >= 500 ? TEXT_WEIGHTS[1] : TEXT_WEIGHTS[0];

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

/** Groups the writer has struck out, from their marks. A `reject` names a
 *  `Device.group` rather than an id, because ids are minted fresh on every run
 *  and the group is derived from the words — so the rejection survives a
 *  re-analysis. */
export const rejectedGroups = (marks: readonly LyricMark[]): Set<string> => {
  const out = new Set<string>();
  for (const m of marks) if (m.verdict === 'reject' && m.target_group) out.add(m.target_group);
  return out;
};

/** The findings the current filters let through, strongest first. `rejected`
 *  is the writer's veto: a group they struck out is gone from every surface
 *  that draws from here, not merely greyed. */
export function visibleDevices(
  doc: LyricAnalysisDoc | null,
  families: FamilyVisibility,
  minConfidence: number,
  rejected?: ReadonlySet<string>,
): Device[] {
  if (!doc) return [];
  return detectedDevices(doc)
    .filter((d) => {
      const fam = asFamily(d.family);
      if (fam === null || !families[fam] || d.confidence < minConfidence) return false;
      return !rejected?.size || !rejected.has(d.group || d.id);
    })
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * What the ENGINE found, with the writer's own marks taken back out.
 *
 * A document's analysis comes back merged: `documents.analysis_bundle` and the
 * run job both hand the pane `service.apply_marks(...)`, which appends every
 * mark and confirm as a `Device` of its own (`mark:` id, confidence 1.0, and
 * the kind's real family when the writer named one). Left alone, a hand-marked
 * internal rhyme is then drawn twice — once as the writer's box and once as a
 * rose detection underneath it — counted as a finding, and offered its own
 * tick-and-cross. The marks are drawn from `marks`, so they are dropped here.
 */
export const detectedDevices = (doc: LyricAnalysisDoc | null): Device[] =>
  doc ? doc.devices.filter((d) => !isMarkDevice(d)) : [];

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
  rejected?: ReadonlySet<string>,
): Map<string, WordDeviceMark> {
  const marks = new Map<string, WordDeviceMark>();
  for (const device of visibleDevices(doc, families, minConfidence, rejected)) {
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
  /** Which word of the line this piece belongs to, -1 for the space between
   *  two of them. Word boundaries are always cut points, so a segment never
   *  straddles two words — which is what lets the writer click one and mark it. */
  word: number;
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
  /** [start, end) of every word in `text`, so a hand-made mark can be turned
   *  back into a `Span` (line, word) without re-tokenising the line. */
  wordRanges: Array<[number, number]>;
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
  /** Index into the line's words. The sheet anchors by character offsets
   *  because a device may claim part of a word; the karaoke has one element
   *  per word and anchors by this instead. */
  word: number;
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
  /** Which hop of its finding this is, and how many there are: a run of five
   *  rhyming words is four wires, and the renderer draws the whole chain when
   *  one of them is picked. */
  hop: number;
  hops: number;
  /** `near` is drawn at rest; `wide` only in ALL mode or when its finding is
   *  open. Set here rather than measured in the renderer, because the reach
   *  that matters is in LINES and the renderer only has pixels. */
  reach: 'near' | 'wide';
  /** Lane the wire is routed in, so two links between the same two lines do
   *  not land on the same curve. Assigned per line-pair, in reading order. */
  lane: number;
}

export interface SheetModel {
  rows: SheetRow[];
  links: SheetLink[];
  /** Every finding's whole chain, keyed by group — including the kinds the
   *  sheet never wires at rest. Opening one draws the run it describes. */
  linksByGroup: Map<string, SheetLink[]>;
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
  // The long-range kinds are here for their ENDS: a callback is two places a
  // verse apart, and the wire between them is the only way to see it on the
  // sheet. Every one of them is far beyond the reach the sheet draws at rest,
  // so they appear when their finding is selected and never bury the words.
  ...LONG_RANGE_KINDS,
]);

/** At rest the layer is capped hard: a refrain repeated forty times must not
 *  bury the words under its own wiring. ALL mode is an explicit request for
 *  the whole web and gets a much higher ceiling — past it the count is
 *  reported rather than the links silently dropped. */
const MAX_LINKS = 140;
const MAX_LINKS_ALL = 900;
/** How far apart two ends can be, in lines, before a wire counts as wide. */
export const LINK_NEAR_LINES = 2;
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
  rejected?: ReadonlySet<string>,
  scope: 'near' | 'all' = 'near',
): SheetModel {
  const empty: SheetModel = {
    rows: [],
    links: [],
    linksByGroup: new Map(),
    linkOverflow: 0,
    maxDevices: 0,
    maxSyllables: 0,
  };
  if (!doc) return empty;

  const metrics = new Map<number, LineMetrics>();
  for (const m of doc.lines) metrics.set(m.line, m);

  const shown = visibleDevices(doc, families, minConfidence, rejected);
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

    // Cut the line wherever a finding starts or stops — and at every word
    // boundary too, so no piece ever straddles two words. That is what lets
    // the writer click one word of plain text and mark it: without the word
    // cuts, "the quick brown" is a single unaddressable run of text.
    const covers: Array<{ device: Device; range: [number, number] }> = [];
    const cuts = new Set<number>([0, text.length]);
    const wordRanges: Array<[number, number]> = [];
    for (let w = 0; w < words.length; w += 1) {
      const ws = flat.starts[w];
      const we = flat.ends[w];
      if (ws === undefined || we === undefined) continue;
      wordRanges.push([ws, we]);
      cuts.add(ws);
      cuts.add(we);
    }
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
    // The bounds run left to right and so do the words, so one cursor finds
    // every segment's word without rescanning the line for each piece.
    let wi = 0;
    for (let k = 0; k < bounds.length - 1; k += 1) {
      const start = bounds[k];
      const end = bounds[k + 1];
      if (end <= start) continue;
      while (wi < wordRanges.length && wordRanges[wi][1] <= start) wi += 1;
      const word =
        wi < wordRanges.length && start >= wordRanges[wi][0] && end <= wordRanges[wi][1] ? wi : -1;
      const here = covers.filter((c) => c.range[0] <= start && c.range[1] >= end).map((c) => c.device);
      if (!here.length) {
        segments.push({
          start,
          end,
          text: text.slice(start, end),
          word,
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
        word,
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
      wordRanges,
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
  //
  // Two scopes. At rest only the kinds a list genuinely hides are wired — an
  // internal rhyme, an echo a line down — because a rap lyric answers itself
  // constantly and every answer as a wire buries the words. In ALL scope
  // every finding with more than one place in it is wired end to end, which
  // is the whole web: rhyme classes, assonance runs, refrains, puns.
  const built: SheetLink[] = [];
  let linkOverflow = 0;
  // Lanes are per PAIR OF LINES, so two wires between the same two lines are
  // routed at different depths instead of drawn on top of each other.
  const lanes = new Map<string, number>();
  for (const d of shown) {
    if (d.spans.length < 2) continue;
    const family = asFamily(d.family);
    if (!family) continue;
    const ends: SheetLinkEnd[] = [];
    for (const sp of d.spans) {
      const flat = flats.get(sp.line);
      if (!flat) continue;
      const range = spanRange(flat, sp);
      if (!range) continue;
      ends.push({
        line: sp.line,
        word: sp.word,
        start: range[0],
        end: range[1],
        text: flat.text.slice(range[0], range[1]),
      });
    }
    const ink = groupInk(d.group || d.id);
    const hops = Math.max(0, ends.length - 1);
    for (let k = 1; k < ends.length; k += 1) {
      if (built.length >= MAX_LINKS_ALL) {
        linkOverflow += 1;
        continue;
      }
      const a = ends[k - 1];
      const b = ends[k];
      const pair = a.line <= b.line ? `${a.line}:${b.line}` : `${b.line}:${a.line}`;
      const lane = lanes.get(pair) ?? 0;
      lanes.set(pair, lane + 1);
      built.push({
        id: `${d.id}:${k}`,
        deviceId: d.id,
        group: d.group || d.id,
        kind: d.kind,
        label: d.label,
        family,
        rgb: ink.rgb,
        dash: ink.dash,
        confidence: d.confidence,
        a,
        b,
        hop: k,
        hops,
        reach: Math.abs(b.line - a.line) <= LINK_NEAR_LINES ? 'near' : 'wide',
        lane,
      });
    }
  }

  // Every group's whole chain, whatever the scope. This is what lets opening
  // an assonance run — a kind the sheet never wires at rest — draw the run it
  // is: the wires that tie the words of THAT finding together.
  const linksByGroup = new Map<string, SheetLink[]>();
  for (const link of built) {
    const list = linksByGroup.get(link.group);
    if (list) list.push(link);
    else linksByGroup.set(link.group, [link]);
  }

  let links = built;
  if (scope !== 'all') {
    links = built.filter((l) => LINK_KINDS.has(l.kind));
    if (links.length > MAX_LINKS) {
      linkOverflow += links.length - MAX_LINKS;
      links = links.slice(0, MAX_LINKS);
    }
  }

  return { rows, links, linksByGroup, linkOverflow, maxDevices, maxSyllables };
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

// --- the writer's own marks ------------------------------------------------
//
// Marks are drawn as a HAND, never as another detector: a finding is a rule
// underlining a word, a mark is a box drawn round one with a nib in its corner.
// Nobody should have to compare two shades of pink to know whose finding it is.

export const MARK_RGB: Record<MarkVerdict, string> = {
  mark: '251 191 36', // amber — the writer's own hand
  confirm: '52 211 153', // emerald — agreed with, and kept as ground truth
  reject: '148 163 184', // slate — struck out
};

export const MARK_GLYPH: Record<MarkVerdict, string> = {
  mark: '✎',
  confirm: '✓',
  reject: '✕',
};

export const MARK_WORDS: Record<MarkVerdict, string> = {
  mark: 'your mark',
  confirm: 'confirmed — real, kept as ground truth',
  reject: 'rejected — the engine got this wrong',
};

export interface MarkWordCell {
  verdict: MarkVerdict;
  /** Every mark on this word, so the sheet can open the right one. */
  ids: string[];
  groups: string[];
  title: string;
}

const MARK_TITLE_LABELS = 3;

/** Word -> the writer's mark on it, keyed `line:word` (the karaoke's own key).
 *
 *  Rejects are deliberately absent: a reject is a statement about a FINDING,
 *  not about the word, and striking the word through would say the writer
 *  thinks their own lyric is wrong. A reject shows as the finding disappearing
 *  and as a struck row in the marks list. `stale` names the marks the lyric has
 *  moved out from under, which are not painted at all. */
export function buildMarkIndex(
  marks: readonly LyricMark[],
  stale?: ReadonlySet<string>,
): Map<string, MarkWordCell> {
  const out = new Map<string, MarkWordCell>();
  for (const mark of marks) {
    if (mark.verdict === 'reject') continue;
    // A stale mark's anchors no longer name the words it was placed on, so
    // painting it would put a box round whatever the writer has since written
    // at that index — a highlight they never made. The server skips them for
    // exactly this reason (`apply_marks(skip=stale)`); the list still shows
    // them, with the words they were placed on, so they can be re-placed.
    if (stale?.has(mark.id)) continue;
    const label = clip(mark.label || mark.kind || 'mark', TITLE_MAX_LABEL_CHARS);
    for (const span of mark.spans) {
      if (span.line < 0 || span.word < 0) continue;
      const key = wordMarkKey(span.line, span.word);
      const prev = out.get(key);
      if (!prev) {
        out.set(key, {
          verdict: mark.verdict,
          ids: [mark.id],
          groups: [mark.group || mark.id],
          title: label,
        });
        continue;
      }
      if (!prev.ids.includes(mark.id)) {
        prev.ids.push(mark.id);
        if (prev.ids.length <= MARK_TITLE_LABELS) prev.title = `${prev.title} · ${label}`;
        else if (prev.ids.length === MARK_TITLE_LABELS + 1) prev.title = `${prev.title} · …`;
      }
      const group = mark.group || mark.id;
      if (!prev.groups.includes(group)) prev.groups.push(group);
      // A confirmation is the stronger statement, so it wins the word's look.
      if (mark.verdict === 'confirm') prev.verdict = 'confirm';
    }
  }
  return out;
}

// --- the shape of the scheme over distance ---------------------------------
//
// `rhyme-run`, `rhyme-chain`, `callback` and `bookend` are about a whole song,
// not a pair of words, and a flat list flattens exactly the thing that makes
// them interesting: how far they reach. The map below lays them out over the
// lyric's own line axis — the same axis the shape strip uses, so the two stack
// and read as one picture — with each kind drawn as its own SHAPE.

export interface StructureBand {
  id: string;
  deviceId: string;
  kind: string;
  /** RUN / CHAIN / CALL / ENDS: the band says what it is in words, not in hue. */
  code: string;
  label: string;
  detail: string;
  group: string;
  rgb: string;
  confidence: number;
  /** Lines this finding actually lands on, in reading order. */
  lines: number[];
  /** The same, as column positions on the strip's axis. */
  positions: number[];
  start: number;
  end: number;
  sections: string[];
}

export interface StructureMapModel {
  bands: StructureBand[];
  /** Columns on the axis: one per non-blank row, matching the shape strip. */
  columns: number;
  /** Findings past the cap; named in the UI, never silently dropped. */
  overflow: number;
}

const EMPTY_STRUCTURE: StructureMapModel = { bands: [], columns: 0, overflow: 0 };

/**
 * The long-range rhyme findings over the lyric's own line axis — the same axis
 * the shape strip uses, so the map stacks under it and the two read as one
 * picture of the song.
 *
 * One band per finding, in reading order, each with its reach drawn as a track
 * and its kind said in words. Lanes were tried and dropped: packed bands are
 * prettier and unreadable at 300px, where a band can be nine pixels wide with
 * nowhere to put its name. Past `maxBands` the rest are counted into `overflow`
 * rather than stacked into a pile nobody can read.
 */
export function buildStructureMap(
  devices: readonly Device[],
  rows: readonly SheetRow[],
  maxBands = 14,
): StructureMapModel {
  if (!rows.length) return EMPTY_STRUCTURE;

  // The axis is the shape strip's: one column per non-blank row. A blank line
  // takes the column of the next real one, so a band never collapses to
  // nothing just because it starts after a stanza break.
  const colForLine = new Map<number, number>();
  const sectionOf = new Map<number, string>();
  let columns = 0;
  for (const row of rows) {
    colForLine.set(row.line, columns);
    sectionOf.set(row.line, row.section);
    if (!row.blank) columns += 1;
  }
  if (!columns) return EMPTY_STRUCTURE;
  const posOf = (line: number): number => {
    const col = colForLine.get(line);
    if (col === undefined) return line < 0 ? 0 : columns - 1;
    return Math.max(0, Math.min(columns - 1, col));
  };

  const wanted = devices.filter((d) => LONG_RANGE_KINDS.includes(d.kind));
  const built = wanted
    .map((d) => {
      const lines = Array.from(new Set(d.spans.map((s) => s.line))).sort((a, b) => a - b);
      if (!lines.length) return null;
      const positions = Array.from(new Set(lines.map(posOf))).sort((a, b) => a - b);
      const sections = Array.from(
        new Set(lines.map((l) => sectionOf.get(l) ?? '').filter(Boolean)),
      );
      return {
        id: d.id,
        deviceId: d.id,
        kind: d.kind,
        code: LONG_RANGE_CODE[d.kind] ?? d.kind.toUpperCase(),
        label: d.label,
        detail: d.detail,
        group: d.group || d.id,
        rgb: groupInk(d.group || d.id).rgb,
        confidence: d.confidence,
        lines,
        positions,
        start: positions[0],
        end: positions[positions.length - 1],
        sections,
      };
    })
    .filter((b): b is StructureBand => b !== null);

  // Reach first, so when the cap bites it is the short local shape that goes
  // and not the callback that crosses the whole song.
  const ranked = [...built].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || b.confidence - a.confidence,
  );
  const keep = new Set(ranked.slice(0, maxBands).map((b) => b.id));
  const bands = built
    .filter((b) => keep.has(b.id))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.kind.localeCompare(b.kind));
  return { bands, columns, overflow: built.length - bands.length };
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
  /** How much of the wiring the sheet draws. */
  linkMode: LinkMode;
  /** Show the per-line stress pattern beside the sheet. */
  stress: boolean;
  /** Reading size and weight of the lyric, shared by the sheet and the
   *  writing surface so the two panes are never set differently. */
  textSize: number;
  textWeight: number;
  /** Selecting words in one pane lights them in the other. */
  mirrorSelection: boolean;
  /** The sheet follows the playhead, the way the karaoke does. */
  followPlayback: boolean;
  /** Draw the rhyme wiring over the karaoke words as well as over the sheet. */
  karaokeLinks: boolean;
  /** Words lit by the other pane's selection, keyed `line:word`. Session
   *  state, never persisted: it is where the cursor is, not a preference. */
  echo: ReadonlySet<string>;
  /** The device group the findings list has selected; the karaoke lights it up. */
  selectedGroup: string | null;
  /** The one finding being inspected: its spans, phones and reason. Always in
   *  the selected group, but a group can hold several findings. */
  selectedDeviceId: string | null;
  llm: boolean;
  provider: string;
  model: string;

  /** The document the marks below belong to: a library entry in SING, a
   *  notebook page in LYRIC. Kept apart from `entryId` because the writing
   *  surface hosts its own analysis and never sets that one. */
  marksDocId: string | null;
  marks: LyricMark[];
  /** Ids the lyric has moved out from under: the server could not find the
   *  words they were placed on any more. Never painted, always listed. */
  marksStale: string[];
  /** Marks the last save refused because every anchor named a line or word the
   *  lyric does not have. Shown rather than silently swallowed. */
  marksDropped: number;
  /** False when the subject cannot hold marks at all — a library entry in SING,
   *  which the marks routes answer 404 for. The pane offers no marking then. */
  marksSupported: boolean;
  marksLoading: boolean;
  marksSaving: boolean;
  marksError: string | null;
  /** The sheet is in marking mode: a click on a word puts it in the selection
   *  instead of opening the finding under it. */
  markMode: boolean;

  load: (entryId: string) => Promise<void>;
  run: (opts?: RunOptions) => Promise<void>;
  remove: () => Promise<void>;
  probe: () => Promise<void>;
  clear: () => void;
  setFamily: (family: DeviceFamily, on: boolean) => void;
  setMinConfidence: (v: number) => void;
  setOverlay: (on: boolean) => void;
  setLinkMode: (mode: LinkMode) => void;
  setStress: (on: boolean) => void;
  setTextSize: (px: number) => void;
  setTextWeight: (weight: number) => void;
  setMirrorSelection: (on: boolean) => void;
  setFollowPlayback: (on: boolean) => void;
  setKaraokeLinks: (on: boolean) => void;
  setEcho: (keys: ReadonlySet<string>) => void;
  setSelectedGroup: (group: string | null) => void;
  setSelectedDevice: (device: Device | null) => void;
  setLlm: (on: boolean) => void;
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  clearError: () => void;

  loadMarks: (docId: string) => Promise<void>;
  /** Send whatever the debounce is still holding. Called on unmount and before
   *  the document changes, so nothing the writer marked is left in memory. */
  flushMarks: () => Promise<void>;
  /** The new mark's id, or '' when the subject cannot hold marks. */
  addMark: (input: NewMark) => string;
  updateMark: (id: string, patch: Partial<Omit<LyricMark, 'id' | 'created_at'>>) => void;
  removeMark: (id: string) => void;
  /** "That is not a rhyme": hides the finding's whole group everywhere. */
  rejectDevice: (device: Device) => void;
  /** "Yes, that is real": kept as ground truth beside the analysis. */
  confirmDevice: (device: Device) => void;
  /** Take back a confirm or a reject, by the `Device.group` it named. */
  clearVerdict: (group: string) => void;
  setMarkMode: (on: boolean) => void;
  clearMarksError: () => void;
  /** Take back the "N were not stored" notice once it has been read. */
  clearMarksDropped: () => void;
}

/** A mark before the store gives it an id and its timestamps. */
export interface NewMark {
  kind?: string;
  label?: string;
  group?: string;
  spans: Span[];
  note?: string;
  verdict?: MarkVerdict;
  target_group?: string;
}

// One generation counter so a slow load for the previous entry cannot land on
// top of the entry the user has since selected.
let loadGeneration = 0;

// Marking is a click-click-click action, and the writer's hand moves faster
// than any request should. Every edit lands in memory at once and the PUT waits
// for a pause — never one per selection, never one per keystroke in the label.
const MARKS_DEBOUNCE_MS = 700;
let marksTimer: ReturnType<typeof setTimeout> | null = null;
let marksGeneration = 0;
// Only a set the writer actually CHANGED may be sent. Without this, the pane
// unmounting while the load was still in flight PUT the empty list it starts
// from and wiped every mark on the document — which React's double-invoked
// mount effects reproduce on every single open in development.
let marksDirty = false;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const now = (): number => Date.now() / 1000;

/** Client-minted, because the whole set is PUT at once and the server never
 *  needs to hand an id back before the mark can be drawn. */
const mintId = (prefix: string): string => {
  try {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  } catch {
    return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  }
};

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

  /** Hold the new set, then PUT it once the writer stops. The list in memory is
   *  the truth for the whole debounce window, so the sheet repaints instantly
   *  however slow the request is. */
  const armMarksTimer = (): void => {
    if (marksTimer) clearTimeout(marksTimer);
    marksTimer = setTimeout(() => {
      marksTimer = null;
      void get().flushMarks();
    }, MARKS_DEBOUNCE_MS);
  };

  const writeMarks = (marks: LyricMark[]): void => {
    marksDirty = true;
    set({ marks });
    armMarksTimer();
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
    linkMode: readLinkMode(),
    stress: readBool(KEY_STRESS, false),
    textSize: readSize(),
    textWeight: readWeight(),
    mirrorSelection: readBool(KEY_MIRROR, true),
    followPlayback: readBool(KEY_FOLLOW, false),
    karaokeLinks: readBool(KEY_KARAOKE_LINKS, false),
    echo: new Set<string>() as ReadonlySet<string>,
    selectedGroup: null,
    selectedDeviceId: null,
    // The interpretive pass costs a call to a provider, so it never turns
    // itself on: the checkbox starts off every session.
    llm: false,
    provider: readString(KEY_PROVIDER, ''),
    model: readString(KEY_MODEL, ''),

    marksDocId: null,
    marks: [],
    marksStale: [],
    marksDropped: 0,
    marksSupported: false,
    marksLoading: false,
    marksSaving: false,
    marksError: null,
    markMode: readBool(KEY_MARK_MODE, false),

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
      // The marks go out before the id does — this runs when the writer leaves
      // the song, and the debounce may still be holding their last one.
      void get().flushMarks();
      marksGeneration += 1;
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
        marksDocId: null,
        marks: [],
        marksStale: [],
        marksDropped: 0,
        marksSupported: false,
        marksLoading: false,
        marksError: null,
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
    setLinkMode: (mode) => {
      set({ linkMode: LINK_MODES.includes(mode) ? mode : 'near' });
      writeStorage(KEY_LINK_MODE, get().linkMode);
    },
    setStress: (on) => {
      set({ stress: on });
      writeStorage(KEY_STRESS, on ? '1' : '0');
    },
    setTextSize: (px) => {
      const next = nearestSize(px);
      set({ textSize: next });
      writeStorage(KEY_TEXT_SIZE, String(next));
    },
    setTextWeight: (weight) => {
      const next = weight >= 500 ? TEXT_WEIGHTS[1] : TEXT_WEIGHTS[0];
      set({ textWeight: next });
      writeStorage(KEY_TEXT_WEIGHT, String(next));
    },
    setMirrorSelection: (on) => {
      // Switching it off has to take the highlight with it, or the last
      // selection stays lit on the sheet with nothing able to clear it.
      set({ mirrorSelection: on, ...(on ? {} : { echo: new Set<string>() as ReadonlySet<string> }) });
      writeStorage(KEY_MIRROR, on ? '1' : '0');
    },
    setFollowPlayback: (on) => {
      set({ followPlayback: on });
      writeStorage(KEY_FOLLOW, on ? '1' : '0');
    },
    setKaraokeLinks: (on) => {
      set({ karaokeLinks: on });
      writeStorage(KEY_KARAOKE_LINKS, on ? '1' : '0');
    },
    // Set from whichever pane owns the caret. Compared before it is stored so
    // a textarea firing selectionchange on every keystroke cannot re-render
    // the sheet for a selection that has not moved.
    setEcho: (keys) => {
      const prev = get().echo;
      if (prev.size === keys.size) {
        let same = true;
        for (const k of keys) {
          if (!prev.has(k)) {
            same = false;
            break;
          }
        }
        if (same) return;
      }
      set({ echo: keys });
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

    loadMarks: async (docId) => {
      if (get().marksDocId === docId && !get().marksError) return;
      // Whatever is still on the debounce belongs to the document being left.
      await get().flushMarks();
      const generation = ++marksGeneration;
      // The empty list below is a placeholder, not an edit: nothing may send it.
      marksDirty = false;
      // A subject with no home for marks is not an error and not a load: the
      // routes only know lyric documents, so SING's library entry would answer
      // 404 to the GET and to every save after it. Say so by turning the
      // marking off rather than by fetching a failure.
      if (!isMarkableDocId(docId)) {
        set({
          marksDocId: docId,
          marks: [],
          marksStale: [],
          marksDropped: 0,
          marksSupported: false,
          marksLoading: false,
          marksError: null,
        });
        return;
      }
      set({
        marksDocId: docId,
        marks: [],
        marksStale: [],
        marksDropped: 0,
        marksSupported: true,
        marksLoading: true,
        marksError: null,
      });
      try {
        const bundle = await fetchLyricMarks(docId);
        if (generation !== marksGeneration) return;
        marksDirty = false;
        set({ marks: bundle.marks, marksStale: bundle.stale, marksLoading: false });
      } catch (e) {
        if (generation !== marksGeneration) return;
        // The writer must know their marks are not being read, or they will
        // mark a song twice: this shows in the pane rather than being eaten.
        set({ marksLoading: false, marksError: errorMessage(e) });
      }
    },

    flushMarks: async () => {
      if (marksTimer) {
        clearTimeout(marksTimer);
        marksTimer = null;
      }
      const { marksDocId, marks, marksSaving, marksSupported } = get();
      // Nothing was marked, or the set on screen is still the one being
      // fetched: there is nothing of the writer's to send.
      if (!marksDocId || !marksDirty) return;
      // Nowhere to send it. `addMark` refuses in the first place, so reaching
      // here means the subject changed under a pending edit; drop the timer
      // rather than spend a request on a certain 404.
      if (!marksSupported || !isMarkableDocId(marksDocId)) {
        marksDirty = false;
        return;
      }
      // A PUT is already in flight. It re-arms the debounce when it lands, so
      // whatever was marked in the meantime still goes out — dropping it here
      // would lose the writer's last few marks silently.
      if (marksSaving) {
        armMarksTimer();
        return;
      }
      const generation = marksGeneration;
      set({ marksSaving: true });
      let stored: LyricMarksBundle | null = null;
      let failed: string | null = null;
      try {
        stored = await putLyricMarks(marksDocId, marks);
      } catch (e) {
        failed = errorMessage(e);
      }
      // The flag belongs to THIS call and is cleared however it ended. Clearing
      // it only on the paths that are still current would leave it stuck true
      // when the writer changed document mid-flight, and every later save would
      // then see a PUT "in flight" that had long since finished.
      set({ marksSaving: false });
      if (generation !== marksGeneration || get().marksDocId !== marksDocId) return;
      if (failed !== null) {
        set({ marksError: failed });
        return;
      }
      if (!stored) return;
      // Only take the server's list wholesale when nothing was marked while the
      // PUT was in flight, or the newer marks would be thrown away by their own
      // save. When something WAS marked, the ids still have to be taken: the
      // server mints them and never accepts a client's, so a set re-sent under
      // the client's own ids arrives as a set of strangers — re-minted again,
      // with fresh timestamps, and (worse) with its spans re-read off the
      // document instead of kept verbatim, which is what drops a mark whose
      // line has since been rewritten. The answer is in request order and only
      // shorter when something was dropped, so a 1:1 answer maps id to id.
      const settled = get().marks === marks;
      const patch: Partial<LyricAnalysisState> = { marksError: null, marksDropped: stored.dropped };
      if (settled) {
        patch.marks = stored.marks;
        patch.marksStale = stored.stale;
      } else if (stored.marks.length === marks.length) {
        const byId = new Map(marks.map((m, i) => [m.id, stored.marks[i]]));
        patch.marks = get().marks.map((m) => {
          const mine = byId.get(m.id);
          return mine ? { ...m, id: mine.id, created_at: mine.created_at } : m;
        });
      }
      set(patch);
      if (settled) marksDirty = false;
      else armMarksTimer();
    },

    addMark: (input) => {
      // Nowhere to save it: better no mark than one that looks saved and is
      // gone on the next open. The pane hides the whole marking flow when this
      // is false, so this is the backstop, not the message.
      if (!get().marksSupported) return '';
      const id = mintId('mark');
      const stamp = now();
      const mark: LyricMark = {
        id,
        kind: input.kind ?? '',
        label: input.label ?? '',
        // Marks sharing a group are one thing — and a mark made on its own is
        // still a group of one, so it can be extended later.
        group: input.group || mintId('mgrp'),
        spans: input.spans,
        note: input.note ?? '',
        verdict: input.verdict ?? 'mark',
        target_group: input.target_group ?? '',
        created_at: stamp,
        updated_at: stamp,
      };
      writeMarks([...get().marks, mark]);
      return id;
    },

    updateMark: (id, patch) => {
      writeMarks(
        get().marks.map((m) => (m.id === id ? { ...m, ...patch, id, updated_at: now() } : m)),
      );
    },

    removeMark: (id) => {
      writeMarks(get().marks.filter((m) => m.id !== id));
    },

    rejectDevice: (device) => {
      const group = device.group || device.id;
      if (get().marks.some((m) => m.verdict === 'reject' && m.target_group === group)) return;
      get().addMark({
        kind: device.kind,
        label: device.label,
        spans: device.spans,
        verdict: 'reject',
        target_group: group,
      });
      // The finding is about to vanish from every list; nothing may stay
      // selected that can no longer be seen.
      if (get().selectedGroup === group) set({ selectedGroup: null, selectedDeviceId: null });
    },

    confirmDevice: (device) => {
      const group = device.group || device.id;
      if (get().marks.some((m) => m.verdict === 'confirm' && m.target_group === group)) return;
      get().addMark({
        kind: device.kind,
        label: device.label,
        spans: device.spans,
        verdict: 'confirm',
        target_group: group,
      });
    },

    clearVerdict: (group) => {
      writeMarks(
        get().marks.filter((m) => !(m.verdict !== 'mark' && m.target_group === group)),
      );
    },

    setMarkMode: (on) => {
      set({ markMode: on });
      writeStorage(KEY_MARK_MODE, on ? '1' : '0');
    },

    clearMarksError: () => set({ marksError: null }),

    clearMarksDropped: () => set({ marksDropped: 0 }),
  };
});
