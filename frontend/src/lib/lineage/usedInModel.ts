/**
 * Pure view-model for the asset inspector's "Used in" tab: the rows the
 * dialog renders for the projects and renders an entry appears in, and —
 * when the entry IS a render output — the sources it was made from. No
 * React, no fetch, no store: everything here is small, per-entry data the
 * inspector already holds in memory.
 *
 * Units: every `*_sec` field (start_sec, end_sec, source_offset_sec,
 * startSec) is SECONDS. `created_at` and `last_render_at` are ISO-8601 UTC
 * timestamps.
 *
 * Run: npx tsx src/lib/lineage/usedInModel.test.ts
 */

import { formatDateLabel, formatDurationLabel } from '../../components/library/assetInspectorModel';
import type { LineageSources, LineageUsedIn } from './lineageTypes';

/* ------------------------------------------------------------ render kind */

const RENDER_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ['full', 'Full render'],
  ['range', 'Range render'],
  ['stems', 'Stems render'],
  ['clips', 'Clips render'],
]);

/** A render kind as the reader sees it; anything unrecognized reads plainly as a render. */
export function renderKindLabel(kind: unknown): string {
  return typeof kind === 'string' ? (RENDER_KIND_LABELS.get(kind) ?? 'Render') : 'Render';
}

/* ----------------------------------------------------------- render count */

/**
 * A render count in words. Zero, a negative number, a non-integer, or
 * anything that is not a finite number reads as no renders at all — there is
 * no such thing as a fractional or negative render.
 */
export function renderCountLabel(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return 'No renders';
  }
  return n === 1 ? '1 render' : `${n} renders`;
}

/* ----------------------------------------------------------------- ranges */

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** `formatDurationLabel`, except an exact 0 is the start of the track, not `Unknown`. */
function startOrDurationLabel(seconds: number): string {
  return seconds === 0 ? '0:00' : formatDurationLabel(seconds);
}

/**
 * The time range a render or source covered, in the reader's units. Neither
 * side known reads as the whole track; one known side reads as an open range
 * from or up to that point. A start of exactly 0 is a real position (the
 * very beginning of the track) and reads `0:00`, not `Unknown`.
 */
export function rangeLabel(startSec: unknown, endSec: unknown): string {
  const startOk = isFiniteNumber(startSec);
  const endOk = isFiniteNumber(endSec);
  if (startOk && endOk) {
    return `${startOrDurationLabel(startSec)} – ${formatDurationLabel(endSec)}`;
  }
  if (startOk) return `from ${startOrDurationLabel(startSec)}`;
  if (endOk) return `up to ${formatDurationLabel(endSec)}`;
  return 'Whole track';
}

/* -------------------------------------------------------------- projects */

export interface UsedInProjectRow {
  readonly id: string;
  readonly name: string;
  readonly rendersLabel: string;
  readonly lastRenderLabel: string;
  readonly lastRenderAt: number;
  readonly ariaLabel: string;
}

const UNTITLED_PROJECT = 'Untitled project';

/** An ISO-8601 timestamp as epoch milliseconds, or 0 when it cannot be parsed. */
function parsedEpochMs(iso: unknown): number {
  if (typeof iso !== 'string' || iso.trim().length === 0) return 0;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** A project's display name, falling back when the library never recorded one. */
function projectDisplayName(name: unknown): string {
  return typeof name === 'string' && name.trim().length > 0 ? name : UNTITLED_PROJECT;
}

/**
 * The projects this entry was rendered into, newest render first. A project
 * with no usable id is dropped — there is nothing for the row to open.
 */
export function projectRows(usedIn: LineageUsedIn | null | undefined): readonly UsedInProjectRow[] {
  const projects = usedIn?.projects;
  if (!Array.isArray(projects)) return [];
  const rows: UsedInProjectRow[] = [];
  for (const project of projects) {
    const id = typeof project?.project_id === 'string' ? project.project_id : '';
    if (!id) continue;
    const name = projectDisplayName(project?.project_name);
    const rendersLabel = renderCountLabel(project?.renders);
    const lastRenderLabel = formatDateLabel(project?.last_render_at);
    const lastRenderAt = parsedEpochMs(project?.last_render_at);
    rows.push({
      id,
      name,
      rendersLabel,
      lastRenderLabel,
      lastRenderAt,
      ariaLabel: `Open ${name} — ${rendersLabel}, last render ${lastRenderLabel}`,
    });
  }
  return rows.sort((a, b) => b.lastRenderAt - a.lastRenderAt || a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------- renders */

export interface UsedInRenderRow {
  readonly id: string;
  readonly dateLabel: string;
  readonly kindLabel: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly outputEntryId: string | null;
  readonly createdAt: number;
  readonly ariaLabel: string;
}

/**
 * Every render this entry was used in, newest first. A render with no usable
 * id is dropped. `outputEntryId` is null when the render's output was never
 * kept in the library, which the aria label says plainly rather than
 * pretending the row can be opened.
 */
export function renderRows(usedIn: LineageUsedIn | null | undefined): readonly UsedInRenderRow[] {
  const renders = usedIn?.renders;
  if (!Array.isArray(renders)) return [];
  const rows: UsedInRenderRow[] = [];
  for (const render of renders) {
    const id = typeof render?.render_id === 'string' ? render.render_id : '';
    if (!id) continue;
    const kindLabel = renderKindLabel(render?.kind);
    const projectName = projectDisplayName(render?.project_name);
    const dateLabel = formatDateLabel(render?.created_at);
    const outputEntryId =
      typeof render?.output_entry_id === 'string' && render.output_entry_id.length > 0
        ? render.output_entry_id
        : null;
    const ariaLabel = outputEntryId
      ? `Open the ${kindLabel.toLowerCase()} of ${projectName} from ${dateLabel}`
      : `${kindLabel} of ${projectName} from ${dateLabel} — output not in the library`;
    rows.push({
      id,
      dateLabel,
      kindLabel,
      projectId: typeof render?.project_id === 'string' ? render.project_id : '',
      projectName,
      outputEntryId,
      createdAt: parsedEpochMs(render?.created_at),
      ariaLabel,
    });
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/* -------------------------------------------------------------- made from */

export interface MadeFromRow {
  readonly key: string;
  readonly entryId: string;
  readonly rangeLabel: string;
  readonly roleLabel: string;
  readonly startSec: number;
  readonly ariaLabel: string;
}

const CONTRIBUTION_ROLE_LABELS: ReadonlyMap<string, string> = new Map([
  ['audio', 'Audio'],
  ['midi', 'MIDI'],
  ['stem', 'Stem'],
]);

function contributionRoleLabel(role: unknown): string {
  return typeof role === 'string' ? (CONTRIBUTION_ROLE_LABELS.get(role) ?? 'Source') : 'Source';
}

/**
 * The sources actually audible in the render this entry came from, ordered
 * by start time ascending (the order the listener heard them). Empty for
 * anything that is not itself a render output. A contribution with no usable
 * `library_entry_id` is dropped — there is nothing for the row to open.
 */
export function madeFromRows(sources: LineageSources | null | undefined): readonly MadeFromRow[] {
  const contributions = sources?.render?.contributions;
  if (!Array.isArray(contributions)) return [];
  const rows: MadeFromRow[] = [];
  contributions.forEach((contribution, index) => {
    const entryId = typeof contribution?.library_entry_id === 'string' ? contribution.library_entry_id : '';
    if (!entryId) return;
    const clipPart =
      typeof contribution?.clip_id === 'string' && contribution.clip_id.length > 0
        ? contribution.clip_id
        : String(index);
    const startSec = isFiniteNumber(contribution?.start_sec) ? contribution.start_sec : 0;
    const range = rangeLabel(contribution?.start_sec, contribution?.end_sec);
    rows.push({
      key: `${entryId}:${clipPart}`,
      entryId,
      rangeLabel: range,
      roleLabel: contributionRoleLabel(contribution?.role),
      startSec,
      ariaLabel: `Open the source used at ${range}`,
    });
  });
  return rows.sort((a, b) => a.startSec - b.startSec || a.key.localeCompare(b.key));
}

/**
 * The "Made from (n)" heading for the sources section, or an empty string
 * when this entry is not a render output at all — the view's cue to skip
 * the section entirely rather than show it empty.
 */
export function madeFromHeading(sources: LineageSources | null | undefined): string {
  if (!sources?.render) return '';
  return `Made from (${madeFromRows(sources).length})`;
}
