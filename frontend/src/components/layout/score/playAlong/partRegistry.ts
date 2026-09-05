/**
 * Who knows which parts an artifact has?
 *
 * Part visibility lives in playAlongStore keyed by artifact id, but the store
 * only holds booleans; the part NAMES are discovered by whichever view loads
 * the score (OSMD in the strip, the note chart in the highway). The INSTRUMENT
 * preset in the SCORE toolbar needs those names to decide which parts a
 * drummer or a bass player wants, before or without a view that knows them.
 *
 * This module is that small shared memory: views register the parts they
 * learn, the toolbar applies the preset through it, and for a MusicXML sheet
 * whose parts nobody has seen yet the `<part-list>` is fetched and parsed
 * directly (a few kilobytes of regex work, only on an explicit preset).
 *
 * Session-only, like the store's partVisibility.
 */
import { useEffect, useState } from 'react';
import { notationArtifactUrl } from '../../../../lib/notationClient';
import {
  partsForInstrument,
  usePlayAlongStore,
  type PartDescriptor,
  type PlayAlongInstrument,
} from '../../../../state/playAlongStore';

const partsById = new Map<string, PartDescriptor[]>();
/** Instrument whose preset was last written to each artifact's visibility. */
const appliedById = new Map<string, PlayAlongInstrument>();
const pendingById = new Map<string, Promise<PartDescriptor[]>>();
const listeners = new Set<(artifactId: string) => void>();

const notify = (artifactId: string): void => {
  for (const cb of listeners) {
    try {
      cb(artifactId);
    } catch {
      /* one listener must not silence the rest */
    }
  }
};

/** Remember the parts of an artifact (a view that loaded it calls this). */
export function registerParts(artifactId: string, parts: readonly PartDescriptor[]): void {
  if (!artifactId) return;
  const next = parts.map((p) => ({ name: p.name || '', isPercussion: p.isPercussion === true }));
  const prev = partsById.get(artifactId);
  const same =
    !!prev &&
    prev.length === next.length &&
    prev.every((p, i) => p.name === next[i].name && p.isPercussion === next[i].isPercussion);
  partsById.set(artifactId, next);
  if (!same) notify(artifactId);
}

/** The parts known for an artifact, or null when nothing has loaded it yet. */
export function knownParts(artifactId: string | null | undefined): PartDescriptor[] | null {
  if (!artifactId) return null;
  const parts = partsById.get(artifactId);
  return parts ? parts.slice() : null;
}

/** The instrument whose preset currently governs an artifact's visibility. */
export function presetApplied(artifactId: string): PlayAlongInstrument | null {
  return appliedById.get(artifactId) ?? null;
}

export function subscribeParts(cb: (artifactId: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Write the instrument preset into the store's part visibility for an
 * artifact. Returns false when the parts are not known yet (nothing written).
 * Without `force`, a preset already applied for the same instrument is left
 * alone, so the player's manual PART toggles survive re-selecting the same
 * artifact; `force` is the explicit INSTRUMENT change, which always wins.
 * 'all' only writes when forced (the default visibility is what PartFilter
 * seeds anyway).
 */
export function applyInstrumentPreset(
  artifactId: string,
  instrument: PlayAlongInstrument,
  opts: { force?: boolean } = {},
): boolean {
  const parts = partsById.get(artifactId);
  if (!parts) return false;
  if (!opts.force && appliedById.get(artifactId) === instrument) return true;
  appliedById.set(artifactId, instrument);
  if (instrument === 'all' && !opts.force) return true;
  usePlayAlongStore.getState().setPartVisibility(artifactId, partsForInstrument(instrument, parts));
  return true;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const textOf = (block: string, tag: string): string => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
};

/** How much of a part body to inspect for a percussion clef / unpitched notes. */
const PART_HEAD_CHARS = 40000;

/**
 * Parse a MusicXML document's `<part-list>` into PartDescriptors, in score
 * order (the order OSMD's Instruments and the note chart's parts use). A part
 * is percussion when its score-part declares an unpitched MIDI instrument or
 * channel 10, when the head of its body opens with a percussion clef or
 * unpitched notes, or when it is plainly named so. Pure string work: no DOM.
 */
export function parseMusicXmlPartList(xml: string): PartDescriptor[] {
  const listMatch = /<part-list(?:\s[^>]*)?>([\s\S]*?)<\/part-list>/i.exec(xml);
  if (!listMatch) return [];
  const out: PartDescriptor[] = [];
  const scorePartRe = /<score-part\b([^>]*)>([\s\S]*?)<\/score-part>/gi;
  let m: RegExpExecArray | null;
  while ((m = scorePartRe.exec(listMatch[1])) !== null) {
    const idMatch = /\bid\s*=\s*"([^"]*)"/i.exec(m[1]) ?? /\bid\s*=\s*'([^']*)'/i.exec(m[1]);
    const id = idMatch ? idMatch[1] : '';
    const block = m[2];
    const name = textOf(block, 'part-name') || textOf(block, 'part-abbreviation');
    let percussion = /<midi-unpitched>/i.test(block) || /<midi-channel>\s*10\s*<\/midi-channel>/i.test(block);
    if (!percussion && id) {
      const open = new RegExp(`<part\\s+id\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*>`, 'i').exec(xml);
      if (open) {
        // Never read past this part's own closing tag: a short part would
        // otherwise be judged by the part that follows it.
        const close = xml.indexOf('</part>', open.index);
        const end = Math.min(close === -1 ? xml.length : close, open.index + PART_HEAD_CHARS);
        const head = xml.slice(open.index, end);
        percussion = /<sign>\s*percussion\s*<\/sign>/i.test(head) || /<unpitched>/i.test(head);
      }
    }
    if (!percussion && /drum|percussion/i.test(name)) percussion = true;
    out.push({ name: name || `Part ${out.length + 1}`, isPercussion: percussion });
  }
  return out;
}

/**
 * Learn a MusicXML artifact's parts without a renderer: fetch the file and
 * parse its part-list. Cached per artifact, deduplicated while in flight,
 * registered on success. Throws on a failed fetch or an unparsable document.
 */
export function discoverParts(artifactId: string): Promise<PartDescriptor[]> {
  const known = partsById.get(artifactId);
  if (known) return Promise.resolve(known.slice());
  const pending = pendingById.get(artifactId);
  if (pending) return pending;
  const task = (async () => {
    try {
      const res = await fetch(notationArtifactUrl(artifactId));
      if (!res.ok) throw new Error(`MusicXML HTTP ${res.status}`);
      const parts = parseMusicXmlPartList(await res.text());
      if (parts.length === 0) throw new Error('no <part-list> in the MusicXML');
      registerParts(artifactId, parts);
      return parts;
    } finally {
      pendingById.delete(artifactId);
    }
  })();
  pendingById.set(artifactId, task);
  return task;
}

/** Test/diagnostic helper: forget everything. */
export function resetPartRegistry(): void {
  partsById.clear();
  appliedById.clear();
  pendingById.clear();
}

/** React binding: the known parts of an artifact, re-rendering when a view
 *  registers them. */
export function useKnownParts(artifactId: string | null | undefined): PartDescriptor[] | null {
  const [parts, setParts] = useState<PartDescriptor[] | null>(() => knownParts(artifactId));
  useEffect(() => {
    setParts(knownParts(artifactId));
    if (!artifactId) return;
    return subscribeParts((id) => {
      if (id === artifactId) setParts(knownParts(artifactId));
    });
  }, [artifactId]);
  return parts;
}
