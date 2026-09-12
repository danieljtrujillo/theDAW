/**
 * The SCORE toolbar's EXPORT menu, as data: which parts the menu lists and,
 * for each part, which formats it offers, in what order, and why an entry is
 * disabled. Pure: no React, no DOM, so the tsx test runs it under plain node.
 *
 * Level one is the part ("All parts", then each part of the sheet in score
 * order); level two is the format. Any part goes to any format: the export
 * route's options.parts scopes musicxml / abc / pdf / svg / notechart to one
 * part (the backend filters the sheet with stage_parts, then converts), the
 * pack takes ?parts=, and Beat Saber has its own part filter. So the format
 * column is the same list for every part; only what an entry DOES differs:
 * the whole-sheet XML is a plain download of the file, the one-part XML is a
 * conversion (a new sheet holding that part).
 *
 * A MIDI artifact gets the same formats for All parts (the backend stages it
 * through music21 on the way); its parts are not listed, because a MIDI has
 * no <part-list> to read.
 *
 * PDF and SVG each come from either engraver — the headless OSMD renderer
 * (the SCORE tab's own) first, MuseScore as the stand-in — so they are offered
 * when the backend lists them. When it does not (neither engraver present),
 * both are disabled with the reason, and two entries follow the formats: GET
 * MUSESCORE (a link to the download page) and LOCATE MUSESCORE… (an action the
 * owner handles: pick the executable, save it in Settings, re-read
 * capabilities).
 */
import type { NotationCapabilities } from '../../../lib/notationClient';
import type { PartDescriptor } from '../../../state/playAlongStore';

/**
 * Formats POST /api/notation/{entry}/export turns a sheet into, in menu
 * order. musicxml and midi are inputs here; musicxml is also the target of a
 * one-part XML export (see routeFormatFor).
 *
 * Whether each one is offered comes from caps.formats, never from a guess
 * about the machine: the old toolbar hardcoded
 * `caps.musescore ? ['abc','pdf','svg'] : ['abc']`, which on a machine
 * without MuseScore hid the headless-OSMD PDF and the Unity note chart even
 * though both work. capabilities() lists pdf and svg when EITHER engraver
 * (OSMD or MuseScore) is present, so intersecting it with this list is the
 * honest answer.
 */
export const SHEET_EXPORT_ORDER = ['pdf', 'abc', 'svg', 'notechart', 'beatsaber'] as const;
export type SheetExportFormat = (typeof SHEET_EXPORT_ORDER)[number];

/** What the export route is asked for; 'musicxml' is the one-part XML. */
export type ExportRouteFormat = SheetExportFormat | 'musicxml';

export type ExportEntryId = 'xml' | 'pack' | 'file' | SheetExportFormat | 'get-musescore' | 'locate-musescore';

/** What choosing an entry does: follow an `<a download>`, POST an export,
 *  open the Beat Saber popover (which POSTs its own export), open an external
 *  page (`href`, in the system browser), or hand an action id to the owner. */
export type ExportEntryKind = 'download' | 'export' | 'popover' | 'link' | 'action';

/** Where GET MUSESCORE goes when the backend does not say. */
export const MUSESCORE_DOWNLOAD_URL = 'https://musescore.org/download';

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
  /** True when choosing this entry exports ONE part (the highlighted one):
   *  the export route gets options.parts, the pack gets ?parts=. */
  partScoped: boolean;
  /** 'link' entries only: where the link goes. */
  href?: string;
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
  'get-musescore': 'GET MUSESCORE',
  'locate-musescore': 'LOCATE MUSESCORE…',
};

const ENGRAVER_NOTE =
  'engraved by the headless OSMD renderer, the engraver the SCORE tab draws with; MuseScore stands in when it is missing';

/** Hover text for an offered sheet export of the whole sheet. */
const OFFERED_TITLES: Record<SheetExportFormat, string> = {
  pdf: `Export PDF from this score (${ENGRAVER_NOTE})`,
  abc: 'Export ABC from this score',
  svg: `Export SVG from this score (${ENGRAVER_NOTE})`,
  notechart: 'Export the Unity note chart (timecode + spelled notes) from this score',
  beatsaber: 'Export a Beat Saber level pack (Info.dat + one .dat per difficulty + song.ogg) from this score',
};

/** Hover text for an offered sheet export of ONE part. */
function partTitle(id: SheetExportFormat, part: ExportMenuPart): string {
  switch (id) {
    case 'pdf':
    case 'svg':
      return `Export ${LABELS[id]} of ${part.label} only (${ENGRAVER_NOTE})`;
    case 'notechart':
      return `Export the Unity note chart of ${part.label} only`;
    case 'beatsaber':
      return `Export a Beat Saber level pack mapping only ${part.label}`;
    default:
      return `Export ${LABELS[id]} of ${part.label} only`;
  }
}

const XML_TITLE = 'MusicXML — the sheet itself';
const XML_SHEET_TITLE = 'MusicXML sheet made from this MIDI (the MAKE SHEET conversion)';
const PACK_ENGRAVER_NOTE =
  'a PDF engraved on download by the headless OSMD renderer, or MuseScore when it is missing (the source alone with neither); a big score takes a few seconds';
const PACK_TITLE = `MusicXML + ${PACK_ENGRAVER_NOTE}`;
const MIDI_PACK_TITLE = `MIDI + ${PACK_ENGRAVER_NOTE}`;
const CAPS_PENDING = 'Reading backend capabilities…';

/** Why a sheet export is not offered. The pdf/svg reason mirrors how
 *  capabilities() gates them (backend/modules/notation/engine.py): either
 *  engraver, OSMD or MuseScore, is enough, so missing both is the only way
 *  to lose them — and the two entries under the formats fix that. */
function unavailableReason(id: SheetExportFormat, caps: NotationCapabilities | null): string {
  if (!caps) return CAPS_PENDING;
  switch (id) {
    case 'pdf':
    case 'svg':
      return `${LABELS[id]} needs the headless OSMD renderer (node) or MuseScore on the backend — GET MUSESCORE or LOCATE MUSESCORE… below`;
    default:
      return `${LABELS[id]} is not offered by this backend`;
  }
}

const offered = (id: SheetExportFormat, caps: NotationCapabilities | null): boolean =>
  !!caps && (caps.formats ?? []).includes(id);

/** The export route's format for an 'export' entry ('xml' asks for a
 *  musicxml conversion; the rest are their own ids). */
export function routeFormatFor(entry: ExportMenuEntry): ExportRouteFormat {
  return entry.id === 'xml' ? 'musicxml' : (entry.id as SheetExportFormat);
}

/** A sheet format for the whole sheet (part null) or for one part. */
function sheetEntry(id: SheetExportFormat, caps: NotationCapabilities | null, part: ExportMenuPart | null): ExportMenuEntry {
  const ok = offered(id, caps);
  const scoped = part !== null && part.index !== null;
  if (id === 'beatsaber') {
    // The popover POSTs its own export; a percussion part is never mapped.
    const blocked = scoped && part.isPercussion;
    return {
      id,
      label: LABELS[id],
      kind: 'popover',
      enabled: ok && !blocked,
      title: !ok
        ? unavailableReason(id, caps)
        : blocked
          ? 'Percussion parts are never mapped to Beat Saber blocks'
          : scoped
            ? partTitle(id, part)
            : OFFERED_TITLES[id],
      partScoped: scoped,
    };
  }
  return {
    id,
    label: LABELS[id],
    kind: 'export',
    enabled: ok,
    title: ok ? (scoped ? partTitle(id, part) : OFFERED_TITLES[id]) : unavailableReason(id, caps),
    partScoped: scoped,
  };
}

/** GET MUSESCORE + LOCATE MUSESCORE…, only when an engraved format is
 *  missing (with capabilities known): the way to get PDF and SVG back. */
function engraverEntries(caps: NotationCapabilities | null): ExportMenuEntry[] {
  if (!caps || (offered('pdf', caps) && offered('svg', caps))) return [];
  return [
    {
      id: 'get-musescore',
      label: LABELS['get-musescore'],
      kind: 'link',
      href: caps.musescore_download_url ?? MUSESCORE_DOWNLOAD_URL,
      enabled: true,
      title: 'Open the MuseScore download page',
      partScoped: false,
    },
    {
      id: 'locate-musescore',
      label: LABELS['locate-musescore'],
      kind: 'action',
      enabled: true,
      title: 'Point theDAW at an installed MuseScore (saved in Settings)',
      partScoped: false,
    },
  ];
}

/** Every format for the whole sheet: XML, the pack, then the export route's
 *  targets. For a MIDI the XML is a conversion (there is no sheet to download
 *  yet) and the pack is MIDI + PDF. */
function allPartsFormats(caps: NotationCapabilities | null, kind: 'musicxml' | 'midi'): ExportMenuEntry[] {
  const xml: ExportMenuEntry =
    kind === 'midi'
      ? { id: 'xml', label: 'XML (sheet)', kind: 'export', enabled: !!caps, title: caps ? XML_SHEET_TITLE : CAPS_PENDING, partScoped: false }
      : { id: 'xml', label: LABELS.xml, kind: 'download', enabled: true, title: XML_TITLE, partScoped: false };
  const pack: ExportMenuEntry = {
    id: 'pack',
    label: kind === 'midi' ? 'MIDI + PDF PACK' : LABELS.pack,
    kind: 'download',
    enabled: true,
    title: kind === 'midi' ? MIDI_PACK_TITLE : PACK_TITLE,
    partScoped: false,
  };
  return [xml, pack, ...SHEET_EXPORT_ORDER.map((id) => sheetEntry(id, caps, null)), ...engraverEntries(caps)];
}

/**
 * Every format for ONE part. Same order as All parts; every format entry is
 * part-scoped: the XML is a conversion that keeps only this part (a plain
 * download would be the whole file), the pack downloads with ?parts=, the
 * export-route formats POST options.parts, Beat Saber pre-selects the part in
 * its popover.
 */
function onePartFormats(part: ExportMenuPart, caps: NotationCapabilities | null): ExportMenuEntry[] {
  return [
    {
      id: 'xml',
      label: LABELS.xml,
      kind: 'export',
      enabled: !!caps,
      title: caps ? `MusicXML of ${part.label} only (a new sheet holding that part)` : CAPS_PENDING,
      partScoped: true,
    },
    {
      id: 'pack',
      label: LABELS.pack,
      kind: 'download',
      enabled: true,
      title: `MusicXML of ${part.label} only + ${PACK_ENGRAVER_NOTE}`,
      partScoped: true,
    },
    ...SHEET_EXPORT_ORDER.map((id) => sheetEntry(id, caps, part)),
    ...engraverEntries(caps),
  ];
}

export function buildExportMenu(input: ExportMenuInput): ExportMenuModel {
  const { artifactKind, caps, parts } = input;
  const isSheet = artifactKind === 'musicxml' || artifactKind === 'midi';
  // Only a MusicXML has a <part-list>; a MIDI exports as All parts only.
  const listsParts = artifactKind === 'musicxml';
  const menuParts: ExportMenuPart[] = [ALL_PARTS];
  if (listsParts && parts) {
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
        // A PDF, an ABC file, a Beat Saber pack: the artifact IS the export;
        // the only thing to do with it is download it.
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
      return part.index === null
        ? allPartsFormats(caps, artifactKind === 'midi' ? 'midi' : 'musicxml')
        : onePartFormats(part, caps);
    },
  };
}
