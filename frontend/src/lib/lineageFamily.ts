/**
 * A song's lineage family, read from one of the two lineage routes.
 *
 * `/api/library/{id}/lineage` is the screen route. It stops at the server's
 * node cap (600) so one view never has to draw an enormous family, and it says
 * when it did: `truncated` means more of the family exists than the answer
 * holds, and `capped` means the cap (or its per-hop read bound) is the reason.
 *
 * `/api/library/{id}/lineage/full` is the whole family within the depth, with
 * no cap, streamed as it is walked. Save lineage writes that answer, and the
 * INFO tab, the asset inspector and the catalogue load it when the user asks
 * for the whole family.
 */
import type { LineageEdge, LineageNode } from './lineageInsights';
import { describeHttpError } from './httpError';
import { saveFile, type SaveFileResult } from './saveFile';
import { fmtSize } from './trackFacts';
import { useStatusBarStore } from '../state/statusBarStore';
import type { StatusLevel } from '../state/statusNoticeStore';

/** The depth Save lineage has always walked. */
export const EXPORT_LINEAGE_DEPTH = 8;

export interface FamilyRead {
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** More of this family exists than these nodes, for any reason. */
  truncated: boolean;
  /** The screen route's node cap or read bound cut this answer, so the whole
   *  family is larger than what is shown. The depth alone never sets it. */
  capped: boolean;
  /** This answer came from the whole-family route. */
  whole: boolean;
  /** The depth this answer was walked to. */
  depth: number;
}

export const lineageUrl = (entryId: string, depth: number): string =>
  `/api/library/${encodeURIComponent(entryId)}/lineage?depth=${depth}`;

export const wholeLineageUrl = (entryId: string, depth: number): string =>
  `/api/library/${encodeURIComponent(entryId)}/lineage/full?depth=${depth}`;

const count = (n: number): string => n.toLocaleString('en-US');

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What one answer says. A backend with no cap at all sends neither flag, and
 * what it sends is the whole family to the depth. A backend that says
 * `truncated` without saying why is read as capped, so the whole family stays
 * one press away rather than hidden behind a guess.
 */
export function familyFromAnswer(body: unknown, depth: number, whole: boolean): FamilyRead {
  const j = (body && typeof body === 'object' ? body : {}) as {
    nodes?: unknown;
    edges?: unknown;
    truncated?: unknown;
    capped?: unknown;
  };
  const truncated = j.truncated === true;
  return {
    nodes: Array.isArray(j.nodes) ? (j.nodes as LineageNode[]) : [],
    edges: Array.isArray(j.edges) ? (j.edges as LineageEdge[]) : [],
    truncated,
    capped: whole ? false : typeof j.capped === 'boolean' ? j.capped : truncated,
    whole,
    depth,
  };
}

/** The screen route's answer for one song. */
export async function readFamily(
  entryId: string,
  depth: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FamilyRead> {
  const res = await fetchImpl(lineageUrl(entryId, depth));
  if (!res.ok) throw new Error(await describeHttpError(res));
  return familyFromAnswer(await res.json(), depth, false);
}

/** A backend started before the whole-family route existed answers it with
 *  FastAPI's bare "Not Found". The backend does not reload itself, so this is
 *  the state between updating theDAW and restarting it. */
export class WholeWalkMissing extends Error {
  constructor() {
    super('this backend has no whole-family walk yet; restart theDAW to load it');
    this.name = 'WholeWalkMissing';
  }
}

export interface WholeFamily {
  family: FamilyRead;
  /** The answer's bytes as the backend sent them, ready to save. */
  blob: Blob;
  bytes: number;
}

/**
 * The whole family within `depth` generations.
 *
 * The answer is streamed, so a connection that drops mid-walk leaves a body
 * that ends early. It is parsed before anything uses it, and its closing
 * `node_count` / `edge_count` must match what arrived: a family is never
 * shown or saved as whole when part of it is missing.
 */
export async function readWholeFamily(
  entryId: string,
  depth: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WholeFamily> {
  const res = await fetchImpl(wholeLineageUrl(entryId, depth));
  if (res.status === 404) {
    const body = (await res.clone().json().catch(() => null)) as { detail?: unknown } | null;
    if (body?.detail === 'Not Found') throw new WholeWalkMissing();
  }
  if (!res.ok) throw new Error(await describeHttpError(res));
  const blob = await res.blob();
  let body: { node_count?: unknown; edge_count?: unknown };
  try {
    body = JSON.parse(await blob.text()) as typeof body;
  } catch {
    throw new Error('the lineage answer was cut off before it finished');
  }
  const family = familyFromAnswer(body, depth, true);
  if (body.node_count !== family.nodes.length || body.edge_count !== family.edges.length) {
    throw new Error('the lineage answer does not hold the family it counted');
  }
  return { family, blob, bytes: blob.size };
}

/** "1,201 songs, 3 other sources, 1,203 links, 84.1 KB". */
export function describeFamilySize(family: FamilyRead, bytes: number): string {
  const songs = family.nodes.filter((n) => n.kind === 'entry').length;
  const others = family.nodes.length - songs;
  const parts = [`${count(songs)} song${songs === 1 ? '' : 's'}`];
  if (others > 0) parts.push(`${count(others)} other source${others === 1 ? '' : 's'}`);
  parts.push(`${count(family.edges.length)} link${family.edges.length === 1 ? '' : 's'}`);
  parts.push(fmtSize(bytes));
  return parts.join(', ');
}

export interface SaveLineageDeps {
  fetchImpl?: typeof fetch;
  save?: typeof saveFile;
}

const NOT_SAVED: SaveFileResult = { path: null, cancelled: false, downloaded: false };

/**
 * Save lineage: the whole family within {@link EXPORT_LINEAGE_DEPTH}
 * generations, with its size in the status bar and the LOG before the Save
 * dialog opens.
 *
 * On a backend too old to have the whole-family route, the screen route's
 * answer is saved and the status says what it holds and that a restart brings
 * the whole family. Like `saveFile`, this never throws: a failure is reported
 * and returned.
 */
export async function saveWholeLineage(
  entry: { id: string; title: string },
  suggestedName: string,
  deps: SaveLineageDeps = {},
): Promise<SaveFileResult> {
  const { fetchImpl = fetch, save = saveFile } = deps;
  const status = useStatusBarStore.getState();
  const title = entry.title || entry.id;
  let blob: Blob;
  let note: string;
  let level: StatusLevel = 'info';
  try {
    const read = await readWholeFamily(entry.id, EXPORT_LINEAGE_DEPTH, fetchImpl);
    blob = read.blob;
    note = `LINEAGE: "${title}", ${describeFamilySize(read.family, read.bytes)}`;
    if (read.family.truncated) {
      note += `. Relatives further than ${EXPORT_LINEAGE_DEPTH} generations are left out`;
      level = 'warn';
    }
  } catch (e) {
    if (!(e instanceof WholeWalkMissing)) {
      status.setText(`SAVE FAILED: lineage of "${title}": ${message(e)}`, { source: 'library', level: 'error' });
      return NOT_SAVED;
    }
    try {
      const res = await fetchImpl(lineageUrl(entry.id, EXPORT_LINEAGE_DEPTH));
      if (!res.ok) throw new Error(await describeHttpError(res));
      blob = await res.blob();
      const family = familyFromAnswer(JSON.parse(await blob.text()), EXPORT_LINEAGE_DEPTH, false);
      const held = family.capped
        ? `the nearest ${count(family.nodes.length)} of a larger family`
        : describeFamilySize(family, blob.size);
      note = `LINEAGE: "${title}", ${held}. This backend predates the whole-family export; restart theDAW to save the whole family`;
      level = 'warn';
    } catch (fallback) {
      status.setText(`SAVE FAILED: lineage of "${title}": ${message(fallback)}`, { source: 'library', level: 'error' });
      return NOT_SAVED;
    }
  }
  status.setText(note, { source: 'library', level });
  return save({ blob, suggestedName, kind: 'lineage-json' });
}
