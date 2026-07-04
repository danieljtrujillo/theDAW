/**
 * Showcase-track picker.
 *
 * "Et Tu Machina" is the single-song showcase. It is one enriched
 * library entry that already carries six stems, seven MIDI files, and
 * several MusicXML scores, so one title resolves song, stems, MIDI,
 * and score for every media scene. For multi-song / lineage
 * screenshots, we pick a small cohort with similar BPM + duration to
 * make the screenshots coherent (e.g., "here's a chimera fusion of
 * these three roughly 120bpm tracks").
 *
 * `pickShowcaseTrack()` hits SA3's library API (/api/library/entries),
 * looks for the exact title match first, then a case-insensitive
 * substring match. Falls back to the longest entry by duration if
 * nothing matches — better than crashing the screenshot run.
 *
 * `pickNotationTrack()` resolves the notation source the same way. It
 * defaults to the same "Et Tu Machina" entry because that entry
 * already carries the MIDI and score artifacts. A future split of song
 * and notation onto separate entries is one env change
 * (SA3_NOTATION_TRACK) away.
 */

export interface LibraryEntry {
  id: string;
  title: string;
  duration: number;
  fileSizeBytes: number;
  timestamp: string;
  model: string;
  favorite: boolean;
  source: string;
}

const SHOWCASE_TITLE = process.env.SA3_SHOWCASE_TRACK ?? 'Et Tu Machina';
const NOTATION_TITLE = process.env.SA3_NOTATION_TRACK ?? 'Et Tu Machina';

async function fetchEntries(baseUrl: string): Promise<LibraryEntry[]> {
  const r = await fetch(`${baseUrl}/api/library/entries`);
  if (!r.ok) throw new Error(`library api returned ${r.status}`);
  const body = (await r.json()) as unknown;
  // Backend may return either a raw array or an envelope `{entries:
  // [...]}` / `{items: [...]}`. Handle all three.
  if (Array.isArray(body)) return body as LibraryEntry[];
  if (body && typeof body === 'object') {
    const envelope = body as { entries?: LibraryEntry[]; items?: LibraryEntry[] };
    return envelope.entries ?? envelope.items ?? [];
  }
  return [];
}

// Three-tier title resolution shared by both pickers. Exact title
// wins, then a case-insensitive substring, then the longest entry by
// duration so a run never crashes on a title miss.
function resolveByTitle(entries: LibraryEntry[], title: string): LibraryEntry | null {
  if (entries.length === 0) return null;

  // Exact-title match first.
  const exact = entries.find((e) => e.title === title);
  if (exact) return exact;

  // Case-insensitive substring — covers "et tu machina.wav",
  // "Et Tu Machina (final).flac", etc.
  const needle = title.toLowerCase();
  const substr = entries.find((e) => e.title.toLowerCase().includes(needle));
  if (substr) return substr;

  // Fallback: longest track by duration. Likely the most "showcase-y"
  // entry available so screenshots aren't of a 1-second blip.
  const sorted = [...entries].sort((a, b) => b.duration - a.duration);
  return sorted[0] ?? null;
}

export async function pickShowcaseTrack(
  baseUrl: string,
): Promise<LibraryEntry | null> {
  const entries = await fetchEntries(baseUrl);
  return resolveByTitle(entries, SHOWCASE_TITLE);
}

/**
 * Resolve the notation source (the entry that carries MIDI and score
 * artifacts). Defaults to the same "Et Tu Machina" entry as the song,
 * which already carries seven MIDI files and several MusicXML scores.
 * Override with SA3_NOTATION_TRACK to point notation scenes at a
 * separate entry without touching any scene code.
 */
export async function pickNotationTrack(
  baseUrl: string,
): Promise<LibraryEntry | null> {
  const entries = await fetchEntries(baseUrl);
  return resolveByTitle(entries, NOTATION_TITLE);
}

/**
 * Pick a cohort of N entries for multi-track demos. Prefers tracks
 * whose duration is within ±25% of the showcase track's duration so
 * the cohort feels related. If we can't find enough similar tracks,
 * falls back to "the most-recent N entries".
 *
 * Used for: lineage / chimera / library-multi-select screenshots
 * where showing 3-4 tracks is more interesting than just one.
 */
export async function pickCohort(
  baseUrl: string,
  n: number,
): Promise<LibraryEntry[]> {
  const seed = await pickShowcaseTrack(baseUrl);
  const all = await fetchEntries(baseUrl);
  if (all.length === 0) return [];
  if (!seed) {
    return all.slice(0, n);
  }
  const target = seed.duration;
  const tolerated = all
    .filter((e) => e.id !== seed.id)
    .map((e) => ({
      entry: e,
      delta: Math.abs(e.duration - target) / Math.max(target, 1),
    }))
    .sort((a, b) => a.delta - b.delta)
    .filter((x) => x.delta <= 0.25)
    .map((x) => x.entry);
  const cohort = [seed, ...tolerated].slice(0, n);
  if (cohort.length < n) {
    // Pad with whatever else exists, ordered by recency, dedup-safe.
    const seen = new Set(cohort.map((e) => e.id));
    const recent = [...all]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .filter((e) => !seen.has(e.id));
    while (cohort.length < n && recent.length > 0) {
      cohort.push(recent.shift()!);
    }
  }
  return cohort;
}
