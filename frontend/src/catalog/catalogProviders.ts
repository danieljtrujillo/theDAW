/**
 * catalogProviders — provider/platform registry for the cross-platform
 * Catalogue.
 *
 * A "provider" is the engine that produced a track: Stable Audio (theDAW's
 * native generations), Suno, Magenta, Udio, an external import, etc. The
 * library `LibraryEntry` has NO `provider` field — it only carries `model` and
 * `source`. So provider is always DERIVED via `inferProvider()`:
 *   model === 'suno'        → 'suno'
 *   everything else         → 'stable-audio'
 * (with a few extra heuristics for other engines if they ever appear).
 *
 * Known providers get nice labels/colors; unknown ids still render with a
 * neutral fallback so a brand-new engine works the instant it shows up, with
 * no code change.
 *
 * IMPORTANT: the Tailwind badge classes below are LITERAL strings, never
 * runtime-built. Tailwind's compiler purges any class name it can't see as a
 * literal in source, so `text-${color}-300` would vanish in production.
 */

export interface ProviderMeta {
  id: string;
  label: string;
  /** Tailwind color-family stem (e.g. 'purple') keyed into BADGE_CLASSES. */
  color: string;
}

/** Built-in providers. Extend freely; unknown ids fall back gracefully. */
export const KNOWN_PROVIDERS: Record<string, ProviderMeta> = {
  'stable-audio': { id: 'stable-audio', label: 'Stable Audio', color: 'purple' },
  suno: { id: 'suno', label: 'Suno', color: 'orange' },
  'gemini-magenta': { id: 'gemini-magenta', label: 'Magenta', color: 'sky' },
  magenta: { id: 'magenta', label: 'Magenta', color: 'sky' },
  udio: { id: 'udio', label: 'Udio', color: 'pink' },
  riffusion: { id: 'riffusion', label: 'Riffusion', color: 'teal' },
  import: { id: 'import', label: 'Imported', color: 'zinc' },
  unknown: { id: 'unknown', label: 'Unknown', color: 'zinc' },
};

/** Display metadata for any provider id (dynamic-safe). */
export const providerMeta = (id: string | null | undefined): ProviderMeta => {
  if (!id) return KNOWN_PROVIDERS.unknown;
  const key = id.toLowerCase();
  if (KNOWN_PROVIDERS[key]) return KNOWN_PROVIDERS[key];
  // Unknown provider: title-case the id and use the neutral color so it still
  // renders a sensible badge.
  const label = id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, label, color: 'zinc' };
};

/**
 * Static badge class strings per color. MUST be literal (not interpolated) so
 * Tailwind's compiler keeps them. Add a row here when introducing a new color.
 */
const BADGE_CLASSES: Record<string, string> = {
  purple: 'text-purple-300 bg-purple-500/10 border-purple-500/30',
  orange: 'text-orange-300 bg-orange-500/10 border-orange-500/30',
  sky: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  pink: 'text-pink-300 bg-pink-500/10 border-pink-500/30',
  teal: 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  emerald: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  zinc: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30',
};

/** Tailwind classes for a provider badge (text + subtle bg/border). */
export const providerBadgeClass = (id: string | null | undefined): string => {
  const { color } = providerMeta(id);
  return BADGE_CLASSES[color] ?? BADGE_CLASSES.zinc;
};

/**
 * Derive the provider of a library entry from whatever signal we have.
 *
 * Per the spec: `model === 'suno'` → 'suno', everything else → 'stable-audio'.
 * A couple of extra `model` heuristics map other engines if their names ever
 * land in the library, and `source === 'import'` keeps imported audio honest.
 */
export const inferProvider = (e: {
  model?: string | null;
  source?: string | null;
}): string => {
  const hay = `${e.model ?? ''}`.toLowerCase();
  if (hay === 'suno' || hay.includes('suno')) return 'suno';
  if (hay.includes('magenta') || hay.includes('gemini')) return 'gemini-magenta';
  if (hay.includes('udio')) return 'udio';
  if (hay.includes('riffusion')) return 'riffusion';
  if (e.source === 'import') return 'import';
  // theDAW's native generations + studio renders are all Stable Audio.
  return 'stable-audio';
};

/** A reasonable default provider list to seed filter dropdowns before
 *  entries exist / to guarantee the common platforms are always offered. */
export const DEFAULT_PROVIDER_ORDER = [
  'stable-audio', 'suno', 'gemini-magenta', 'udio', 'riffusion', 'import',
];
