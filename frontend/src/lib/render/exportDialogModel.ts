/**
 * exportDialogModel — the export dialog's pure request builder.
 *
 * The dialog asks five questions: WHAT to bounce (the mix, one stem per
 * track, or a clip selection), WHEN in time (the whole project, the current
 * timeline selection, or a hand-typed range), WHICH format, WHERE it lands
 * (the library, a download, or both), and a name plus the tail length. This
 * module turns those five answers into the exact `BounceRequest` /
 * `RenderRange` pairs the engine will run — nothing about React, the DOM, or
 * the Zustand stores, so the whole suite runs under plain tsx and the
 * dialog, the preflight and the job builder can all share one model.
 *
 * Two audio formats exist because `encodeBounce` (renderCore.ts) is the whole
 * encoder the app has: `encodeWav(buffer, { float32 })`. There is no mp3,
 * flac, ogg or aiff path to encode to, and no sample-rate or bit-depth
 * control beyond that one boolean — offering one would be a control that
 * cannot work. The render itself is always 44.1 kHz stereo
 * (`BOUNCE_SAMPLE_RATE`), so that is stated to the user rather than exposed
 * as a choice (`SAMPLE_RATE_LABEL`).
 *
 * The third format, MIDI, renders nothing: it writes the arrangement's notes
 * as one type-1 MIDI file (lib/arrangementMidi), so its plan has no audio
 * items and one `midiItems` entry. WHAT picks the clips (the mix: every MIDI
 * track as the mix plays them; stems: the picked tracks; a selection: the
 * picked clips), all in ONE file with a MIDI track per EDIT track, and RANGE
 * picks the span. It has no tail, and it is saved where the user chooses: a
 * MIDI file is not a library take.
 *
 * The three `ExportWhat` branches copy the fidelity flags of
 * `WaveformEditor`'s `mixdownRequest` / `stemRequest` / `selectionRequest`
 * verbatim (see renderCore.ts's header for why those three combinations and
 * no others). They are restated here as literals rather than imported from
 * `components/audio/WaveformEditor.tsx`, so this module stays free of
 * anything that drags React in behind it. `float32` is the one flag
 * `stemRequest` decides from live hosted-VST detection; there is no chain to
 * inspect from a dialog, so here it comes from the user's chosen format
 * instead.
 */
import { BOUNCE_SAMPLE_RATE, type BounceRequest } from '../renderCore';
import type { ArrangementMidiScope } from '../arrangementMidi';
import { MAX_TAIL_SEC, rangeFromSeconds, type RenderRange } from './renderRange';

/* ── the five answers ────────────────────────────────────────────────────── */

export type ExportWhat =
  | { kind: 'mix' }
  | { kind: 'stems'; trackIds: string[] }
  | { kind: 'clips'; clipIds: string[] };

export type ExportRangeMode = 'project' | 'selection' | 'custom';

export type ExportFormatId = 'wav16' | 'wav32' | 'midi';

export type ExportDestination = 'library' | 'download' | 'both';

export interface ExportDialogState {
  /** What to bounce: the whole mix, one stem per selected track, or a clip
   *  selection. */
  what: ExportWhat;
  /** Which span of time to render. */
  rangeMode: ExportRangeMode;
  /** The current timeline selection in seconds, or null when there is none.
   *  Only read when `rangeMode` is 'selection'. */
  selectionSec: { startSec: number; endSec: number } | null;
  /** The hand-typed range in seconds. Only read when `rangeMode` is
   *  'custom'. */
  customSec: { startSec: number; endSec: number };
  format: ExportFormatId;
  destination: ExportDestination;
  name: string;
  /** Extra seconds past the range for a tail to decay into. Clamped to
   *  0..MAX_TAIL_SEC before it reaches a request — the same ceiling
   *  `rangeFromSeconds` enforces. */
  tailSec: number;
}

/* ── format catalog ──────────────────────────────────────────────────────── */

export interface ExportFormat {
  id: ExportFormatId;
  label: string;
  /** 'audio' renders through `encodeBounce`; 'midi' writes the notes (lib/arrangementMidi). */
  kind: 'audio' | 'midi';
  ext: 'wav' | 'mid';
  mime: 'audio/wav' | 'audio/midi';
  /** Mirrors `BounceRequest.float32` — the only thing that actually differs
   *  between the two WAVs, since `encodeBounce` only branches on this one
   *  flag. False for MIDI, which renders nothing. */
  float32: boolean;
}

/** The two WAVs `encodeBounce` can write (16-bit PCM, 32-bit float), and MIDI,
 *  which lib/arrangementMidi writes from the notes without rendering. */
export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'wav16', label: 'WAV · 16-bit PCM', kind: 'audio', ext: 'wav', mime: 'audio/wav', float32: false },
  { id: 'wav32', label: 'WAV · 32-bit float', kind: 'audio', ext: 'wav', mime: 'audio/wav', float32: true },
  { id: 'midi', label: 'MIDI · type 1, the notes', kind: 'midi', ext: 'mid', mime: 'audio/midi', float32: false },
];

const FORMATS_BY_ID: Record<ExportFormatId, ExportFormat> = {
  wav16: EXPORT_FORMATS[0],
  wav32: EXPORT_FORMATS[1],
  midi: EXPORT_FORMATS[2],
};

/** The render itself never varies: every bounce is 44.1 kHz stereo. Shown to
 *  the user as a fact, not offered as a choice with only one option. */
export const SAMPLE_RATE_LABEL = '44.1 kHz · stereo (fixed)';

/** What a MIDI export holds, shown where the sample rate is for audio. */
export const MIDI_FORMAT_LABEL = 'Type 1 · 960 PPQ · a track per EDIT track with its program, controllers, pitch bends, tempo map and time signatures';

/** Total over `ExportFormatId` — the union already limits callers to the
 *  ids above, so there is no unknown-id case left to throw on. */
export function formatOf(id: ExportFormatId): ExportFormat {
  return FORMATS_BY_ID[id];
}

/* ── opening state ───────────────────────────────────────────────────────── */

/**
 * The dialog's opening state: the mix, the whole project, WAV 16-bit, both
 * destinations, no tail. `customSec` starts at the full project length so a
 * user who switches to a custom range begins from something valid rather
 * than an empty 0..0 window.
 */
export function defaultExportState(opts: {
  selectionSec?: { startSec: number; endSec: number } | null;
  projectEndSec: number;
  name?: string;
}): ExportDialogState {
  return {
    what: { kind: 'mix' },
    rangeMode: 'project',
    selectionSec: opts.selectionSec ?? null,
    customSec: { startSec: 0, endSec: opts.projectEndSec },
    format: 'wav16',
    destination: 'both',
    name: opts.name ?? 'mixdown',
    tailSec: 0,
  };
}

/* ── the render plan ─────────────────────────────────────────────────────── */

export interface ExportRenderItem {
  kind: 'mixdown' | 'stem' | 'selection';
  label: string;
  trackId?: string;
  request: BounceRequest;
  range: RenderRange | null;
  formatId: ExportFormatId;
  destination: ExportDestination;
}

/** One MIDI file a MIDI-format export writes (lib/arrangementMidi). */
export interface MidiExportItem {
  /** The file name, `.mid` included. */
  label: string;
  /** The clips it takes. */
  scope: ArrangementMidiScope;
  /** The timeline span, or null for the whole arrangement. */
  rangeSec: { startSec: number; endSec: number } | null;
}

export interface ExportRenderPlan {
  /** The audio renders. Empty for the MIDI format. */
  items: ExportRenderItem[];
  /** The MIDI files. Empty for the audio formats; one for MIDI. */
  midiItems: MidiExportItem[];
  /** Set when `rangeMode` needs a range and none can be built — the chosen
   *  span is empty, or 'selection' was asked for with nothing selected.
   *  `items` is still returned (each with `range: null`) so the dialog can
   *  keep showing what WOULD render once the range is fixed. */
  rangeError: string | null;
}

const EMPTY_RANGE_ERROR = 'The chosen range is empty — set an end after the start.';

const clampTailSec = (sec: number): number => {
  if (!Number.isFinite(sec)) return 0;
  return Math.min(MAX_TAIL_SEC, Math.max(0, sec));
};

/** Appends '.wav' unless the name already ends in it (case-insensitively),
 *  so a typed "Take1.WAV" is not doubled into "Take1.WAV.wav". */
const withWavExt = (name: string): string => (/\.wav$/i.test(name) ? name : `${name}.wav`);

/** Appends '.mid' unless the name already ends in '.mid' or '.midi'. */
const withMidExt = (name: string): string => (/\.midi?$/i.test(name) ? name : `${name}.mid`);

/** The clips a MIDI export takes for WHAT: every track as the mix plays them, the picked tracks, or the picked clips. */
const midiScopeOf = (what: ExportWhat): ArrangementMidiScope =>
  what.kind === 'mix'
    ? { kind: 'all' }
    : what.kind === 'stems'
      ? { kind: 'tracks', trackIds: [...what.trackIds] }
      : { kind: 'clips', clipIds: [...what.clipIds] };

/**
 * Turns the dialog's five answers into the exact requests the engine runs.
 * Never throws: an unresolvable range is reported through `rangeError`
 * rather than by leaving `items` empty or raising.
 */
export function buildRenderRequest(state: ExportDialogState): ExportRenderPlan {
  const { float32, kind } = formatOf(state.format);
  const tailSec = clampTailSec(state.tailSec);
  const trimmedName = state.name.trim();
  const base = { sampleRate: BOUNCE_SAMPLE_RATE, float32, tailSec };

  let range: RenderRange | null = null;
  let rangeError: string | null = null;
  let rangeSec: { startSec: number; endSec: number } | null = null;
  if (state.rangeMode === 'selection' || state.rangeMode === 'custom') {
    const sec = state.rangeMode === 'selection' ? state.selectionSec : state.customSec;
    range = sec ? rangeFromSeconds(sec.startSec, sec.endSec, { tailSec }) : null;
    if (!range) rangeError = EMPTY_RANGE_ERROR;
    else if (sec) rangeSec = { startSec: sec.startSec, endSec: sec.endSec };
  }
  // 'project' covers the whole timeline: range stays null, no error.

  const { what } = state;

  // MIDI writes the notes: one file whatever WHAT picks, and no tail.
  if (kind === 'midi') {
    return { items: [], midiItems: [{ label: withMidExt(trimmedName), scope: midiScopeOf(what), rangeSec }], rangeError };
  }

  const items: ExportRenderItem[] = [];

  if (what.kind === 'mix') {
    // Mirrors WaveformEditor's `mixdownRequest`: master + per-track racks,
    // automation, mute AND solo.
    const request: BounceRequest = {
      ...base,
      scope: { kind: 'master' },
      includeFx: true,
      includeAutomation: true,
      includeTrackMix: true,
    };
    items.push({
      kind: 'mixdown',
      label: withWavExt(trimmedName),
      request,
      range,
      formatId: state.format,
      destination: state.destination,
    });
  } else if (what.kind === 'stems') {
    // Mirrors `stemRequest`: the track's own rack, no automation, no track
    // mix. `float32` comes from the chosen format, not from VST detection —
    // there is no live chain to inspect from a dialog.
    for (const trackId of what.trackIds) {
      const request: BounceRequest = {
        ...base,
        scope: { kind: 'track', trackId },
        includeFx: true,
        includeAutomation: false,
        includeTrackMix: false,
      };
      items.push({
        kind: 'stem',
        label: withWavExt(`${trimmedName} — ${trackId}`),
        trackId,
        request,
        range,
        formatId: state.format,
        destination: state.destination,
      });
    }
  } else {
    // Mirrors `selectionRequest`: the picked clips as they play, through
    // their tracks' racks and VST3 inserts, the buses the graph routes them
    // through and the master chain, with the automation and the track mix
    // (lib/render/bounceWalksMix). Solo is ignored: the file holds exactly
    // the clips that were picked.
    const request: BounceRequest = {
      ...base,
      scope: { kind: 'selection', clipIds: what.clipIds },
      includeFx: true,
      includeAutomation: true,
      includeTrackMix: true,
    };
    items.push({
      kind: 'selection',
      label: withWavExt(trimmedName),
      request,
      range,
      formatId: state.format,
      destination: state.destination,
    });
  }

  return { items, midiItems: [], rangeError };
}
