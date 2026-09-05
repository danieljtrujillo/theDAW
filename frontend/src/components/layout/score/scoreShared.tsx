import React, { useEffect, useRef } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { Cursor } from 'opensheetmusicdisplay';
import type { NotationArtifact } from '../../../lib/notationClient';
import { HIGHLIGHT_INKS, readingPosFor, usePlayAlongStore } from '../../../state/playAlongStore';

/** Helpers shared by the SCORE tab's views (PAGE in ScoreView.tsx, and the
 *  STRIP / CHORDS / HIGHWAY play-along views under ./). Everything here was
 *  extracted verbatim from ScoreView.tsx so the page view keeps behaving
 *  exactly as before; the few NEW exports (READING_POS, createNoteHighlighter,
 *  applyStripEngraving) are additions the play-along modes build on. */

/** Karaoke note colour — matches the cursor hairline so they read as one.
 *  This is the default ink; live views read highlightColor() so the INK
 *  preference applies. */
export const NOTE_HIGHLIGHT_COLOR = HIGHLIGHT_INKS.magenta.color;

/** The current ink (playAlongStore.ink) as a CSS colour. */
export const highlightColor = (): string => HIGHLIGHT_INKS[usePlayAlongStore.getState().ink].color;

/** Where the "now" sits across the pane right now (playAlongStore.nowLine),
 *  as a fraction of the pane width. */
export const readingPos = (): number => readingPosFor(usePlayAlongStore.getState().nowLine);

/** Where the "now" sits across the pane, as a fraction of its width. The page
 *  view glides the cursor to this position; the strip pins its now-line here. */
export const READING_POS = 0.38;

/** Tuning ids the backend stores, as a player would say them out loud. */
export const TUNING_LABELS: Record<string, string> = {
  'guitar-standard': 'Standard',
  'guitar-drop-d': 'Drop D',
  'guitar-7-string': '7-String',
  'bass-standard': 'Standard',
  'bass-5-string': '5-String',
  'ukulele-standard': 'Standard (GCEA)',
};

/** Artifact kinds that are not arrangements, as a short display name. */
export const KIND_LABELS: Record<string, string> = {
  midi: 'MIDI',
  musicxml: 'Sheet',
  alphatex: 'Tab',
  abc: 'ABC',
  pdf: 'PDF',
  svg: 'SVG',
  notechart: 'Note Chart',
  chordtrack: 'Chords',
  beatsaber: 'Beat Saber',
  vocal: 'Vocal',
  // The timed-lyrics document recovered from <entry>/lyrics.json (backend
  // notation engine, kind 'lyrics'); listed so it does not fall through to
  // titleCase like an unknown kind.
  lyrics: 'Lyrics',
};

export const titleCase = (value: string): string =>
  value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * What this artifact actually IS, in words: the arrangement style for a score
 * ("Band Score", "Piano Reduction"), or the instrument, tuning, capo and
 * difficulty for a tab ("Bass Tab, 5-String"). The backend has recorded all of
 * this in metadata_json since tabs and arrangements were built (style for
 * arrangements; instrument / tuning_name / capo / difficulty for tabs) and
 * nothing ever displayed it, so a band score and a piano reduction were
 * indistinguishable in the list, as were a drop-D guitar tab and a 5-string
 * bass tab. Falls back to the bare kind when an artifact carries no metadata,
 * which is the case for anything recovered off disk.
 */
export const describeArtifact = (artifact: NotationArtifact): string => {
  let meta: Record<string, unknown> = {};
  try {
    // JSON.parse('null') yields null, not an object, and a metadata_json column
    // holding the literal "null" is a real row shape. Indexing that throws and
    // would take down the whole artifact list, so check the parsed type rather
    // than trusting the parse to have produced a record.
    const parsed: unknown = JSON.parse(artifact.metadata_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }
  const str = (key: string): string =>
    typeof meta[key] === 'string' ? (meta[key] as string).trim() : '';

  const style = str('style');
  if (style) return titleCase(style);

  const instrument = str('instrument');
  if (instrument) {
    const parts = [`${titleCase(instrument)} Tab`];
    const tuningName = str('tuning_name');
    if (tuningName) parts.push(TUNING_LABELS[tuningName] ?? titleCase(tuningName));
    const capo = Number(meta.capo ?? 0);
    if (Number.isFinite(capo) && capo > 0) parts.push(`Capo ${capo}`);
    const difficulty = str('difficulty');
    if (difficulty) parts.push(titleCase(difficulty));
    return parts.join(', ');
  }

  return KIND_LABELS[artifact.kind] ?? titleCase(artifact.kind);
};

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 1.12;
// Scores open (and reset) at 64% rather than 1:1. At full scale the engraving
// runs oversized for the pane; 0.64 fits more music per page and matches the
// size the sheet is actually read at. Also the target of the reset button, so
// resetting never jumps back to the rejected 100% size.
export const ZOOM_DEFAULT = 0.64;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Ctrl/Cmd + scrollwheel zoom on the sheet. A native non-passive listener
 *  is required so the gesture can preventDefault (React's onWheel is passive).
 *  Plain wheel keeps scrolling the page so long scores stay navigable. */
export function useWheelZoom(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onZoomDelta: (factor: number) => void,
) {
  const cb = useRef(onZoomDelta);
  cb.current = onZoomDelta;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      cb.current(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [scrollRef]);
}

/** How long after the last zoom change the real (slow) layout runs. */
export const ZOOM_SETTLE_MS = 220;

/**
 * Zoom without a full engraving pass per wheel tick. Every call scales the
 * already-rendered host with CSS `zoom` (instant), and the real layout
 * runs once, ZOOM_SETTLE_MS after the last change. `renderedZoomRef` is
 * the zoom the host was last engraved at; the caller's `render` must set
 * it and clear `host.style.zoom` when it is done.
 */
export function createZoomSettler(
  hostRef: React.RefObject<HTMLElement | null>,
  renderedZoomRef: React.MutableRefObject<number>,
  render: () => void,
): { preview: (zoom: number) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    preview: (zoom) => {
      const host = hostRef.current;
      if (host && renderedZoomRef.current > 0) {
        const ratio = zoom / renderedZoomRef.current;
        host.style.zoom = Math.abs(ratio - 1) < 1e-3 ? '' : String(ratio);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        render();
      }, ZOOM_SETTLE_MS);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export const ZoomControls: React.FC<{
  zoom: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}> = ({ zoom, onIn, onOut, onReset }) => (
  <div className="absolute bottom-2 right-2 z-10 flex items-center gap-0.5 rounded-md border border-purple-500/40 bg-[#0a080f]/95 px-1 py-0.5 shadow-lg backdrop-blur-sm">
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
      onClick={onOut}
      disabled={zoom <= ZOOM_MIN + 0.001}
      title="Zoom out (Ctrl + scroll)"
      aria-label="Zoom out"
    >
      <Minus className="w-3 h-3" />
    </button>
    <button
      className="min-w-9 text-center text-[9px] font-mono text-purple-200 hover:text-white px-0.5"
      onClick={onReset}
      title="Reset zoom"
      aria-label="Reset zoom to the default scale"
    >
      {Math.round(zoom * 100)}%
    </button>
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
      onClick={onIn}
      disabled={zoom >= ZOOM_MAX - 0.001}
      title="Zoom in (Ctrl + scroll)"
      aria-label="Zoom in"
    >
      <Plus className="w-3 h-3" />
    </button>
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20"
      onClick={onReset}
      title="Fit / reset zoom"
      aria-label="Fit to width"
    >
      <Maximize2 className="w-3 h-3" />
    </button>
  </div>
);

export const A4_RATIO = 297 / 210; // A4 portrait height / width
export const PAGE_GAP = 24; // px between side-by-side pages (matches gap-6)

// Media + symbolic extensions that must never show up in a sheet title.
const TITLE_EXT_RE =
  /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|opus|wma|alac|mp4|mov|webm|mkv|m4v|avi|mid|midi|musicxml|xml)$/i;

// Leading track numbers carried in from ripped/downloaded filenames:
// "04 - Song", "04. Song", "04_Song", "1-04 - Song", "[04] Song", "A4. Song".
// A separator after the number is REQUIRED, which is what keeps a title that
// genuinely opens on a number intact: "99 Luftballons", "7 Nation Army",
// "24K Magic" and "1979" have no separator, so none of them match.
const TRACK_BRACKETED_RE = /^\s*[[(]\s*(?:\d{1,2}[-.])?\d{1,3}\s*[\])]\s*[-–—._]*\s*/;
const TRACK_NUMBERED_RE = /^\s*(?:(?:\d{1,2}[-.])?\d{1,3}|[A-Ha-h]\d{1,2})\s*[-–—._)]+\s*/;
const HAS_LETTER_RE = /\p{L}/u;

/** Drop a leading track number. Bails out when the remainder has no letters,
 *  so an all-numeric title survives whole ("1-800-273-8255", "24 - 7"). */
const stripTrackPrefix = (t: string): string => {
  const stripped = t.replace(TRACK_BRACKETED_RE, '').replace(TRACK_NUMBERED_RE, '');
  return stripped !== t && HAS_LETTER_RE.test(stripped) ? stripped.trim() : t;
};

/** Sanitize a title for engraving: drop a trailing media extension and a
 *  leading track number, and treat music21's "Music21 Fragment" / "Music21"
 *  placeholders as empty. */
export const cleanTitleText = (raw: string): string => {
  const t = (raw || '').trim().replace(TITLE_EXT_RE, '').trim();
  if (/^music21( fragment)?$/i.test(t)) return '';
  return stripTrackPrefix(t);
};

/** Word-wrap a long title by inserting newlines (OSMD splits labels on \n and
 *  centers each line) so a long song name lays out across the page instead of
 *  running off the side. Never truncates; hard-breaks a single oversized word. */
export const wrapTitle = (t: string, budget: number): string => {
  if (t.length <= budget) return t;
  const lines: string[] = [];
  let cur = '';
  for (const w of t.split(/\s+/)) {
    let word = w;
    if (cur && (cur + ' ' + word).length > budget) {
      lines.push(cur);
      cur = '';
    }
    cur = cur ? cur + ' ' + word : word;
    while (cur.length > budget) {
      lines.push(cur.slice(0, budget));
      cur = cur.slice(budget);
      word = cur;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
};

/** Pre-process MusicXML before OSMD renders it so the title block reads like a
 *  real sheet: the SONG name as the centered Title (cleaned of media extensions,
 *  word-wrapped if long), and the ARTIST centered directly beneath it. OSMD maps
 *  <work-title> -> Title and <movement-title> -> Subtitle (confirmed in its
 *  reader), so the song goes in work-title and the artist in movement-title; the
 *  composer credit is disabled in the options so the artist never floats off to
 *  the top-right. Returns the cleaned song title for the running page footer. */
export const prepareMusicXml = (
  xml: string,
  pageWidthPx: number,
  artist: string,
): { xml: string; title: string } => {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return { xml, title: '' };
    const root = doc.documentElement;
    const budget = Math.max(16, Math.floor(pageWidthPx / 13));

    const song = cleanTitleText(
      (doc.querySelector('work > work-title')?.textContent ||
        doc.querySelector('movement-title')?.textContent ||
        '').trim(),
    );

    // Title slot (work-title) = wrapped song name.
    let work = doc.querySelector('work');
    if (!work) {
      work = doc.createElement('work');
      root.insertBefore(work, root.firstChild);
    }
    let workTitle = work.querySelector('work-title');
    if (!workTitle) {
      workTitle = doc.createElement('work-title');
      work.appendChild(workTitle);
    }
    workTitle.textContent = song ? wrapTitle(song, budget) : '';

    // Subtitle slot (movement-title) = artist, centered under the title.
    let movement = doc.querySelector('movement-title');
    if (!movement) {
      movement = doc.createElement('movement-title');
      if (work.nextSibling) root.insertBefore(movement, work.nextSibling);
      else root.appendChild(movement);
    }
    movement.textContent = artist || '';

    // Drop music21's placeholder credit-words so they don't print.
    for (const cw of Array.from(doc.querySelectorAll('credit-words'))) {
      if (/^music21( fragment)?$/i.test((cw.textContent || '').trim())) cw.textContent = '';
    }

    return { xml: new XMLSerializer().serializeToString(doc), title: song };
  } catch {
    return { xml, title: '' };
  }
};

/** Engraving rules that make OSMD output look like sheet music from a book:
 *  smaller text (the default title/labels are oversized for a fitted A4 page),
 *  tidy page margins so music never runs off the side, and compact, even
 *  system spacing. Applied before render; unknown keys on older builds no-op. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const applySheetEngraving = (rules: any): void => {
  if (!rules) return;
  try {
    rules.SheetTitleHeight = 2.2;
    rules.SheetSubtitleHeight = 1.4;
    rules.SheetComposerHeight = 1.5;
    rules.SheetAuthorHeight = 1.4;
    rules.TitleTopDistance = 5.0;
    rules.TitleBottomDistance = 1.0;
    rules.SpacingBetweenTextLines = 1.0;
    rules.MeasureNumberLabelHeight = 1.0;
    rules.InstrumentLabelTextHeight = 1.4;
    rules.LyricsHeight = 1.5;
    rules.InstantaneousTempoTextHeight = 1.6;
    rules.ContinuousTempoTextHeight = 1.4;
    // Generous page margins, especially top + bottom (the bottom margin also
    // houses the injected running footer + page number).
    rules.PageLeftMargin = 4.0;
    rules.PageRightMargin = 4.0;
    rules.PageTopMargin = 5.5;
    // Tall bottom margin: the music must clear the injected running footer +
    // page number that live in the bottom margin (see decoratePages).
    rules.PageBottomMargin = 14.0;
    rules.MinimumDistanceBetweenSystems = 4.0;
    rules.MinSkyBottomDistBetweenSystems = 2.0;
    rules.StaffDistance = 4.0;
    rules.BetweenStaffDistance = 4.0;
    rules.RenderMeasureNumbersOnlyAtSystemStart = true;
  } catch {
    /* older OSMD builds: ignore unsupported rules */
  }
};

/** The sheet engraving without a page: the STRIP view renders one continuous
 *  horizontal staffline (renderSingleHorizontalStaffline) and pins it inside a
 *  scroller, so page margins would only push the music away from the pane's
 *  edges. Text sizes and the 4/4 staff spacing are kept identical to the page
 *  so a system reads the same in both modes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const applyStripEngraving = (rules: any): void => {
  if (!rules) return;
  applySheetEngraving(rules);
  try {
    rules.PageLeftMargin = 0;
    rules.PageRightMargin = 0;
    rules.PageTopMargin = 0;
    rules.PageBottomMargin = 0;
    rules.TitleTopDistance = 0;
    rules.TitleBottomDistance = 0;
    rules.StaffDistance = 4.0;
    rules.BetweenStaffDistance = 4.0;
    // One system: there is nothing between systems to space, and every
    // measure is a "system start" when the whole score is a single line.
    rules.RenderMeasureNumbersOnlyAtSystemStart = false;
  } catch {
    /* older OSMD builds: ignore unsupported rules */
  }
};

/** Something with a live OSMD cursor: the note-highlighter only needs
 *  GNotesUnderCursor, which every OSMD 1.x Cursor exposes. */
export interface NoteHighlighter {
  /** Paint the notehead(s) under the cursor in NOTE_HIGHLIGHT_COLOR, clearing
   *  the previous paint first. Safe to call every step; cheap when nothing
   *  changed underneath. */
  apply: () => void;
  /** Restore every element painted by apply(). */
  clear: () => void;
  /** Forget the painted elements without touching them: render() rebuilt the
   *  SVGs, so the old references are detached and there is nothing to undo. */
  forget: () => void;
}

/** Karaoke highlight: paint the notehead(s) under the cursor. OSMD hands the
 *  graphical notes straight to us (GNotesUnderCursor), and VexFlow's notes
 *  expose their rendered <g> (getSVGGElement) — an inline style on every
 *  child out-specifies VexFlow's fill attributes, no OSMD fork needed.
 *
 *  `getCursor` is a callback because render() throws the Cursor away and
 *  builds a new one; the caller also enforces its OSMD generation there, the
 *  same contract createCursorDriver uses. The page view keeps its own copy of
 *  this logic in ScoreView.tsx; the strip and any future OSMD mount use this. */
export function createNoteHighlighter(getCursor: () => Cursor | null): NoteHighlighter {
  let highlighted: Array<SVGElement | HTMLElement> = [];

  const clear = (): void => {
    for (const el of highlighted) {
      try {
        el.style.fill = '';
        el.style.stroke = '';
      } catch {
        /* detached during a re-render */
      }
    }
    highlighted = [];
  };

  const apply = (): void => {
    clear();
    const cursor = getCursor() as
      | { GNotesUnderCursor?: () => Array<{ getSVGGElement?: () => SVGGElement | undefined }> }
      | null;
    if (!cursor?.GNotesUnderCursor) return;
    const ink = highlightColor();
    try {
      for (const gn of cursor.GNotesUnderCursor()) {
        const g = gn?.getSVGGElement?.();
        if (!g) continue;
        const targets: Array<SVGElement | HTMLElement> = [g, ...Array.from(g.querySelectorAll<SVGElement>('*'))];
        for (const t of targets) {
          if (!t.style) continue;
          t.style.fill = ink;
          t.style.stroke = ink;
          highlighted.push(t);
        }
      }
    } catch {
      /* renderer swapped mid-frame — the next step repaints */
    }
  };

  return {
    apply,
    clear,
    forget: () => {
      highlighted = [];
    },
  };
}

/** Duck-typed handle onto alphaTab's external-media player output — the 1.8
 *  API for "an external audio source is the time axis" (PlayerMode
 *  EnabledExternalMedia). Feature-detected at runtime so an older bundle
 *  degrades to a static tab instead of crashing. */
export interface ExternalMediaOutput {
  updatePosition?: (timeMs: number) => void;
  handler?: unknown;
}
