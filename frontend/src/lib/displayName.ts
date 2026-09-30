/**
 * Display-name cleanup: find an importer's source id in a name, and keep it
 * out of the label.
 *
 * Importers stamp a source id into the filename. Suno writes both shapes:
 *
 *   UrZunzet [edb97fd2-6d1d-4e7f-b94c-36ccd464afc2].mp3   full uuid
 *   UrZunzet - Instrumental [8c80f0ed].mp3                short (8 hex)
 *   UrZunzet - 415cfdeb-21ee-48c9-b013-f23c1adb6ef8.mp3   bare, no brackets
 *
 * That filename becomes a library title, a track name and a clip label, so the
 * id follows the song through every panel that shows its name.
 *
 * The id is worth keeping on disk and in metadata; it just has no business in
 * a label. Stripping happens at the display boundary only, so nothing that
 * resolves a file by name is affected.
 *
 * The hard part is NOT matching. It is not matching too much: brackets are
 * load-bearing in real titles — `[Live]`, `(Remix)`, `[2026-09-14]` — and a
 * greedy strip would quietly rename half a library. Every pattern below is
 * deliberately narrow, and each one is pinned by a test.
 */

/** A full UUID in brackets or parens, with the space that precedes it. */
const BRACKETED_UUID =
  /\s*[[(]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*[\])]/gi;

/**
 * Suno's short id: EXACTLY eight hex characters in brackets.
 *
 * Eight is the whole guard — `[Live]` and `[Remix]` are not hex, `[abc123]` is
 * only six. The digit rule below covers the rest: an eight-letter word built
 * only from a–f (`deadbeef`, `defaced`) would otherwise read as an id, so a
 * match without a digit in it is handed back untouched.
 */
const BRACKETED_SHORT_ID = /\s*[[(]\s*([0-9a-f]{8})\s*[\])]/gi;

/**
 * A full UUID sitting loose in the name rather than in brackets. Anchored to a
 * separator on both sides so it can only ever consume a whole token — a UUID
 * is never part of a real title, but half of one must not be clipped out of a
 * longer hex string.
 */
const BARE_UUID =
  /(^|[\s\-_·])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=$|[\s\-_·.])/gi;

/** Separator debris a removal leaves behind: `Song - .mp3`, `Song ·  · vocals`. */
const DANGLING_SEPARATOR = /\s*[-_·]\s*(?=\.[A-Za-z0-9]+$|$)/;

/** What kind of id was found. `short` is Suno's eight-hex form. */
export type SourceIdKind = 'uuid' | 'short';

export interface SourceIdMatch {
  /** The id itself, without its brackets. */
  id: string;
  kind: SourceIdKind;
  /** Offset of the match within the original name. */
  index: number;
}

/** True when `hex` looks like an id rather than an eight-letter a–f word. */
const looksLikeId = (hex: string): boolean => /\d/.test(hex);

/**
 * Every source id in `name`, in the order they appear.
 *
 * Use this to DETECT — to badge a row, to log what an importer stamped, or to
 * decide whether a name needs cleaning at all. Use `stripSourceId` to render.
 */
export function findSourceIds(name: string | null | undefined): SourceIdMatch[] {
  if (!name) return [];
  const found: SourceIdMatch[] = [];
  for (const m of name.matchAll(BRACKETED_UUID)) {
    const id = m[0].replace(/^[\s[(]+|[\s\])]+$/g, '');
    found.push({ id, kind: 'uuid', index: m.index ?? 0 });
  }
  for (const m of name.matchAll(BARE_UUID)) {
    const id = m[0].replace(/^[\s\-_·]+/, '');
    // A bracketed uuid also satisfies the bare pattern's left separator; the
    // bracketed pass already claimed it, so don't report the same id twice.
    if (!found.some((f) => f.id.toLowerCase() === id.toLowerCase())) {
      found.push({ id, kind: 'uuid', index: m.index ?? 0 });
    }
  }
  for (const m of name.matchAll(BRACKETED_SHORT_ID)) {
    if (looksLikeId(m[1])) found.push({ id: m[1], kind: 'short', index: m.index ?? 0 });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Whether `name` carries any source id. */
export function hasSourceId(name: string | null | undefined): boolean {
  return findSourceIds(name).length > 0;
}

/**
 * `name` without any source id — the form to render.
 *
 * A name that is nothing BUT an id is returned as-is rather than emptied, so a
 * row can never draw blank.
 */
export function stripSourceId(name: string | null | undefined): string {
  if (!name) return '';
  const stripped = name
    .replace(BRACKETED_UUID, '')
    .replace(BARE_UUID, '')
    .replace(BRACKETED_SHORT_ID, (whole, hex: string) => (looksLikeId(hex) ? '' : whole))
    .replace(/\s{2,}/g, ' ')
    .replace(DANGLING_SEPARATOR, '')
    .trim();
  return stripped || name;
}
