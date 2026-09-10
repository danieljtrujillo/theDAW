/**
 * Ranking "where is the X?" against the feature registry.
 *
 * The help popover searches this, not the manual. The manual's own search is a
 * substring filter over heading text, so it can only answer a question you
 * already know the heading for — "where is the library?" finds nothing unless
 * you guessed that the heading is called Library. The registry is small enough
 * to score every entry on every keystroke, it works with the backend down, and
 * — the part no document search can do — a hit carries a selector, so the
 * answer can point at the real control instead of describing it.
 *
 * Pure and DOM-free on purpose: it imports the registry's data half only, so a
 * node test can pin the ranking and a keystroke never waits on anything.
 *
 * The scoring is deliberately dumb — no fuzzy matching, no stemming, no index.
 * Whoever reads this next has to be able to predict what a query returns, and
 * a table of "which field matched, and how squarely" is predictable in a way
 * that an edit-distance threshold is not.
 */
import { FEATURES, type FeatureEntry } from './featureRegistry';

export interface FeatureHit {
  feature: FeatureEntry;
  /** Summed field scores. Only meaningful against other hits for the same query. */
  score: number;
  /** How many of the query's words this entry answered to. Ranks above `score`. */
  hitTokens: number;
}

/**
 * Words people put in a question that say nothing about which feature they
 * mean. Dropped so "where do I make a beat" ranks on `make` and `beat` rather
 * than on every entry whose prose happens to contain "the".
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are',
  'do', 'does', 'how', 'what', 'where', 'when', 'why', 'can', 'my', 'me', 'i',
  'it', 'this', 'that', 'with', 'from', 'get', 'find', 'use', 'you', 'your',
]);

/**
 * Names and aliases short enough that the two-character floor would eat them.
 * DJ and VJ are whole workspaces; dropping their tokens would make the two
 * queries most likely to be typed as-is return nothing.
 */
const SHORT_TERMS = new Set<string>();
for (const f of FEATURES) {
  for (const term of [f.name, ...(f.aliases ?? [])]) {
    const t = term.trim().toLowerCase();
    if (t.length <= 2) SHORT_TERMS.add(t);
  }
}

/** How squarely a token matched, best field wins. Order is the ranking. */
const NAME_EXACT = 100;
const NAME_PREFIX = 60;
const ALIAS_EXACT = 55;
const NAME_PART = 40;
const ALIAS_PART = 30;
const WHERE_PART = 20;
const WHAT_PART = 12;
const HOW_PART = 8;

function scoreToken(f: FeatureEntry, token: string): number {
  const name = f.name.toLowerCase();
  if (name === token) return NAME_EXACT;
  if (name.startsWith(token)) return NAME_PREFIX;
  const aliases = (f.aliases ?? []).map((a) => a.toLowerCase());
  if (aliases.some((a) => a === token)) return ALIAS_EXACT;
  if (name.includes(token)) return NAME_PART;
  if (aliases.some((a) => a.includes(token))) return ALIAS_PART;
  if (f.where.toLowerCase().includes(token)) return WHERE_PART;
  if (f.what.toLowerCase().includes(token)) return WHAT_PART;
  if (f.how.some((h) => h.toLowerCase().includes(token))) return HOW_PART;
  return 0;
}

/** Split a question into the words worth scoring. Exported for the test. */
export function tokenize(query: string): string[] {
  const raw = query.trim().toLowerCase();
  if (!raw) return [];
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => {
    if (STOPWORDS.has(w)) return false;
    return w.length >= 3 || SHORT_TERMS.has(w);
  });
  // A query made entirely of noise ("how do I") still deserves an answer
  // attempt rather than a blank list, so fall back to what was typed.
  return kept.length ? kept : [raw];
}

/**
 * Best matches for a query, most relevant first. Empty for a blank query — the
 * caller shows the `featured` entries instead, which is a better starting point
 * than an arbitrary slice of the whole registry.
 *
 * Dev-only entries never appear: the XR bus panel is a diagnostic, and offering
 * it as an answer to a user's question would be a wrong turn with no way back.
 */
export function searchFeatures(query: string, limit = 6): FeatureHit[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const hits: FeatureHit[] = [];
  for (const feature of FEATURES) {
    if (feature.devOnly) continue;
    let score = 0;
    let hitTokens = 0;
    for (const token of tokens) {
      const s = scoreToken(feature, token);
      if (s > 0) {
        score += s;
        hitTokens += 1;
      }
    }
    if (hitTokens > 0) hits.push({ feature, score, hitTokens });
  }

  // Answering more of the question beats answering one word of it loudly:
  // "sway panel" must not be won by the SWAY workspace on one exact name hit.
  // Ties fall back to the shorter name, then to registry order (Array.sort is
  // stable), so the result list does not shuffle between keystrokes.
  hits.sort(
    (a, b) =>
      b.hitTokens - a.hitTokens ||
      b.score - a.score ||
      a.feature.name.length - b.feature.name.length,
  );
  return hits.slice(0, limit);
}

/** What to show before anything has been typed. */
export function featuredFeatures(): FeatureEntry[] {
  return FEATURES.filter((f) => f.featured && !f.devOnly);
}
