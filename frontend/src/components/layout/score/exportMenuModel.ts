/**
 * The SCORE toolbar's EXPORT menu, as data: which parts the menu lists and,
 * for each part, which formats it offers, in what order, and why an entry is
 * disabled. Pure: no React, no DOM, so the tsx test runs it under plain node.
 *
 * Level one is the part ("All parts", then each part of the sheet in score
 * order); level two is the format. XML (the sheet itself) comes first, then
 * the MusicXML + PDF pack, then the formats the export ROUTE converts to.
 */
import type { NotationCapabilities } from '../../../lib/notationClient';
import type { PartDescriptor } from '../../../state/playAlongStore';

/**
 * Formats POST /api/notation/{entry}/export turns a sheet into, in menu
 * order. musicxml and midi are inputs here, never export targets.
 *
 * Whether each one is offered comes from caps.formats, never from a guess
 * about the machine: the old toolbar hardcoded
 * `caps.musescore ? ['abc','pdf','svg'] : ['abc']`, which on a machine
 * without MuseScore hid the headless-OSMD PDF and the Unity note chart even
 * though both work. capabilities() already accounts for the OSMD renderer
 * and MuseScore separately, so intersecting it with this list is the honest
 * answer.
 */
export const SHEET_EXPORT_ORDER = ['pdf', 'abc', 'svg', 'notechart', 'beatsaber'] as const;
export type SheetExportFormat = (typeof SHEET_EXPORT_ORDER)[number];

export type ExportEntryId = 'xml' | 'pack' | 'file' | SheetExportFormat;

/** What choosing an entry does: follow an `<a download>`, POST an export, or
 *  open the Beat Saber popover (which POSTs its own export). */
export type ExportEntryKind = 'download' | 'export' | 'popover';

export interface ExportMenuPart {
  /** Stable key for React and for the highlighted-part state. */
  key: string;
  label: string;
  /** Index into the sheet's part list in score order (the order OSMD, the
   *  note chart and the Beat Saber exporter all share); null = every part. */
  index: number | null;
  isPercussion: boolean;
}

export interface ExportMenuEntry {
  id: ExportEntryId;
  label: string;
  kind: ExportEntryKind;
  enabled: boolean;
  /** Hover text; when the entry is disabled this is the REASON. */
  title: string;
  /** True only when the export route honours options.parts for this format,
   *  so a per-part entry really exports one part. */
  partScoped: boolean;
}

export interface ExportMenuModel {
  parts: ExportMenuPart[];
  formatsFor(part: ExportMenuPart): ExportMenuEntry[];
}

export interface ExportMenuInput {
  artifactKind: string | null;
  caps: NotationCapabilities | null;
  parts: readonly PartDescriptor[] | null;
}

export const ALL_PARTS: ExportMenuPart = { key: 'all', label: 'All parts', index: null, isPercussion: false };

const LABELS: Record<ExportEntryId, string> = {
  xml: 'XML',
  pack: 'XML + PDF PACK',
  file: 'DOWNLOAD',
  pdf: 'PDF',
  abc: 'ABC',
  svg: 'SVG',
  notechart: 'NOTECHART',
  beatsaber: 'BEAT SABER',
};

/** Hover text for an offered sheet export. */
const OFFERED_TITLES: Record<SheetExportFormat, string> = {
  pdf: 'Export PDF from this score (engraved by the headless OSMD renderer, or MuseScore)',
  abc: 'Export ABC from this score',
  svg: 'Export SVG from this score (engraved by MuseScore)',
  notechart: 'Export the Unity note chart (timecode + spelled notes) from this score',
  beatsaber: 'Export a Beat Saber level pack (Info.dat + one .dat per difficulty + song.ogg) from this score',
};

const XML_TITLE = 'MusicXML — the sheet itself';
const PACK_TITLE =
  'MusicXML + a PDF engraved on download (headless OSMD, MuseScore as fallback); a big score takes a few seconds';

/** Why a sheet export is not offered. The pdf/svg reasons mirror how
 *  capabilities() gates them (backend/modules/notation/engine.py). */
function unavailableReason(id: SheetExportFormat, caps: NotationCapabilities | null): string {
  if (!caps) return 'Reading backend capabilities…';
  switch (id) {
    case 'pdf':
      return 'PDF needs the headless OSMD renderer (node) or MuseScore on the backend';
    case 'svg':
      return 'SVG needs MuseScore on the backend';
    default:
      return `${LABELS[id]} is not offered by this backend`;
  }
}

const offered = (id: SheetExportFormat, caps: NotationCapabilities | null): boolean =>
  !!caps && (caps.formats ?? []).includes(id);

function sheetEntry(id: SheetExportFormat, caps: NotationCapabilities | null): ExportMenuEntry {
  const ok = offered(id, caps);
  return {
    id,
    label: LABELS[id],
    kind: id === 'beatsaber' ? 'popover' : 'export',
    enabled: ok,
    title: ok ? OFFERED_TITLES[id] : unavailableReason(id, caps),
    partScoped: false,
  };
}

/** Every format for the whole sheet: XML, the pack, then the export route's targets. */
function allPartsFormats(caps: NotationCapabilities | null): ExportMenuEntry[] {
  return [
    { id: 'xml', label: LABELS.xml, kind: 'download', enabled: true, title: XML_TITLE, partScoped: false },
    { id: 'pack', label: LABELS.pack, kind: 'download', enabled: true, title: PACK_TITLE, partScoped: false },
    ...SHEET_EXPORT_ORDER.map((id) => sheetEntry(id, caps)),
  ];
}

/**
 * Every format for ONE part. Only the beatsaber converter reads
 * options.parts (backend/modules/notation/engine.py _convert_to_beatsaber →
 * write_beatsaber part_indices); convert_score forwards `options` to no other
 * format, and the XML/pack downloads are the whole file by definition. So
 * every other entry is disabled with that reason rather than silently
 * exporting the whole score under a part's name.
 */
function onePartFormats(part: ExportMenuPart, caps: NotationCapabilities | null): ExportMenuEntry[] {
  const wholeSheetOnly = (id: ExportEntryId, kind: ExportEntryKind): ExportMenuEntry => ({
    id,
    label: LABELS[id],
    kind,
    enabled: false,
    title:
      id === 'xml' || id === 'pack'
        ? `${LABELS[id]} is the whole sheet; choose All parts`
        : `${LABELS[id]} exports every part — POST /api/notation/{entry}/export has no part filter for it; choose All parts`,
    partScoped: false,
  });
  return [
    wholeSheetOnly('xml', 'download'),
    wholeSheetOnly('pack', 'download'),
    ...SHEET_EXPORT_ORDER.map((id): ExportMenuEntry => {
      if (id !== 'beatsaber') return wholeSheetOnly(id, 'export');
      const ok = offered(id, caps);
      const enabled = ok && !part.isPercussion;
      return {
        id,
        label: LABELS[id],
        kind: 'popover',
        enabled,
        title: !ok
          ? unavailableReason(id, caps)
          : part.isPercussion
            ? 'Percussion parts are never mapped to Beat Saber blocks'
            : `Export a Beat Saber level pack mapping only ${part.label}`,
        partScoped: true,
      };
    }),
  ];
}

export function buildExportMenu(input: ExportMenuInput): ExportMenuModel {
  const { artifactKind, caps, parts } = input;
  const isSheet = artifactKind === 'musicxml';
  const menuParts: ExportMenuPart[] = [ALL_PARTS];
  if (isSheet && parts) {
    parts.forEach((p, i) => {
      menuParts.push({
        key: `part-${i}`,
        label: p.name || `Part ${i + 1}`,
        index: i,
        isPercussion: p.isPercussion === true,
      });
    });
  }
  return {
    parts: menuParts,
    formatsFor(part) {
      if (!isSheet) {
        // A PDF, an ABC file, a MIDI, a Beat Saber pack: the artifact IS the
        // export; the only thing to do with it is download it.
        return [
          {
            id: 'file',
            label: LABELS.file,
            kind: 'download',
            enabled: !!artifactKind,
            title: artifactKind ? 'Download this artifact' : 'No artifact selected',
            partScoped: false,
          },
        ];
      }
      return part.index === null ? allPartsFormats(caps) : onePartFormats(part, caps);
    },
  };
}
