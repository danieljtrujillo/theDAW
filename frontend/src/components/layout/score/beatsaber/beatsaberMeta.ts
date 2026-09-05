/**
 * The Beat Saber pack card's view of an artifact's metadata_json — the dict
 * the backend's `_convert_to_beatsaber` stores next to the zip (format,
 * difficulties, note_counts, bpm, bpm_source, version, song_ogg, warning,
 * parts, folder, chart_bpm). Pure parsing so it runs under node:assert.
 */

/** Beat Saber's difficulty names, in game order. */
export const DIFFICULTY_ORDER: readonly string[] = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];

/** A player-facing label for a difficulty name. */
export const DIFFICULTY_LABELS: Record<string, string> = {
  Easy: 'Easy',
  Normal: 'Normal',
  Hard: 'Hard',
  Expert: 'Expert',
  ExpertPlus: 'Expert+',
};

export interface BeatSaberPackMeta {
  format: string;
  /** Difficulties written, in game order. */
  difficulties: string[];
  /** Notes per difficulty name. */
  noteCounts: Record<string, number>;
  /** Info.dat BPM; null when unknown. */
  bpm: number | null;
  /** 'analysis' | 'chart' (what was actually used); '' when unknown. */
  bpmSource: string;
  /** Map format version, 2 or 3; 0 when unknown. */
  version: number;
  /** True when song.ogg was encoded into the pack. */
  songOgg: boolean;
  /** The writer's warning (e.g. no ffmpeg); '' when none. */
  warning: string;
  /** Names of the parts mapped. */
  parts: string[];
  /** On-disk level folder, when recorded. */
  folder: string;
  /** The chart's own tempo, for the BPM line; null when unknown. */
  chartBpm: number | null;
  /** Source artifact id recorded by the exporter, '' when absent. */
  source: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asNumber = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Order difficulty names the way the game lists them; unknown names last,
 *  duplicates dropped. */
export function orderedDifficulties(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const known = DIFFICULTY_ORDER.filter((d) => names.includes(d));
  const rest = names.filter((n) => !DIFFICULTY_ORDER.includes(n));
  return [...known, ...rest].filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
}

/** Parse an artifact's metadata_json (a JSON string, possibly empty or
 *  malformed) into the pack card's shape. Never throws. */
export function parseBeatSaberMeta(metadataJson: string | null | undefined): BeatSaberPackMeta {
  let raw: Record<string, unknown> = {};
  try {
    raw = asRecord(JSON.parse(metadataJson || '{}'));
  } catch {
    raw = {};
  }
  const counts = asRecord(raw.note_counts);
  const noteCounts: Record<string, number> = {};
  for (const [name, value] of Object.entries(counts)) {
    const n = asNumber(value);
    if (n !== null) noteCounts[name] = Math.max(0, Math.round(n));
  }
  const listed = asStringList(raw.difficulties);
  const difficulties = orderedDifficulties(listed.length > 0 ? listed : Object.keys(noteCounts));
  const versionRaw = asNumber(raw.version);
  return {
    format: typeof raw.format === 'string' ? raw.format : '',
    difficulties,
    noteCounts,
    bpm: asNumber(raw.bpm),
    bpmSource: typeof raw.bpm_source === 'string' ? raw.bpm_source : '',
    version: versionRaw !== null ? Math.round(versionRaw) : 0,
    songOgg: raw.song_ogg === true,
    warning: typeof raw.warning === 'string' ? raw.warning : '',
    parts: asStringList(raw.parts),
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    chartBpm: asNumber(raw.chart_bpm),
    source: typeof raw.source === 'string' ? raw.source : '',
  };
}

/** The name of the level folder inside the zip (what goes into CustomLevels):
 *  the recorded folder's basename, else the zip's name minus '.beatsaber.zip'. */
export function levelFolderName(artifactPath: string, folder: string = ''): string {
  const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (folder) {
    const b = base(folder);
    if (b) return b;
  }
  const name = base(artifactPath);
  return name.replace(/\.beatsaber\.zip$/i, '').replace(/\.zip$/i, '');
}

/** Total notes across the listed difficulties. */
export function totalNotes(meta: Pick<BeatSaberPackMeta, 'noteCounts'>): number {
  return Object.values(meta.noteCounts).reduce((a, b) => a + b, 0);
}
