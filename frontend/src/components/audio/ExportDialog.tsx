/**
 * ExportDialog — the UI over `lib/render/exportDialogModel` (T25c / F25).
 *
 * EDIT's export used to be one hardcoded path: COMMIT EDIT always bounced the
 * whole project to 16-bit WAV, into the library and a Save As, with no way to
 * ask for 32-bit float, a track's stems, a clip selection, or a time range.
 * `exportDialogModel.ts` already knows how to turn those five answers (what /
 * range / format / destination / name+tail) into the exact render requests
 * the engine runs — this dialog renders that model's options and returns
 * exactly what it builds. It holds no export logic of its own: every field
 * here is a thin control over one slice of `ExportDialogState`, and the only
 * thing `onExport` receives is `buildRenderRequest(state)`'s own output,
 * unmodified.
 *
 * Opened from a small trigger beside MIXDOWN (`WaveformEditor.tsx`), never in
 * place of it — MIXDOWN stays a real one click for "everything, as WAV", and
 * this dialog is where the other four answers live. Its own opening state
 * (`defaultExportState`) reproduces that one click exactly: mix, whole
 * project, WAV 16-bit, both destinations — so accepting the defaults here IS
 * the old COMMIT EDIT.
 *
 * Modal shape (portal to document.body, overlay click + Escape to dismiss,
 * Tab trapped inside, first field focused on open) follows
 * `components/assets/AssetLibraryModal.tsx` and `TrackMetaDialog.tsx` — the
 * two existing dialogs in this app closest to this one's shape.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  EXPORT_FORMATS,
  MIDI_FORMAT_LABEL,
  SAMPLE_RATE_LABEL,
  buildRenderRequest,
  defaultExportState,
  formatOf,
  type ExportDestination,
  type ExportDialogState,
  type ExportFormatId,
  type ExportRangeMode,
  type ExportRenderPlan,
  type ExportWhat,
} from '../../lib/render/exportDialogModel';
import { MAX_TAIL_SEC } from '../../lib/render/renderRange';

export interface ExportDialogTrackOption {
  id: string;
  name: string;
}

export interface ExportDialogProps {
  onClose: () => void;
  /** Called once, with the exact plan `buildRenderRequest` built from the
   *  dialog's current state — nothing added, nothing stripped. The caller
   *  owns everything about running it; this component does not enqueue or
   *  render anything itself. */
  onExport: (plan: ExportRenderPlan, state: ExportDialogState) => void;
  /** Whole-timeline length, in seconds — the 'project' range and the ceiling
   *  `customSec` opens at. */
  projectEndSec: number;
  /** The current timeline selection in seconds, or null when there is none —
   *  what the 'selection' range mode reads. */
  selectionSec: { startSec: number; endSec: number } | null;
  /** Every track EDIT knows about, for the 'stems' what-picker. */
  tracks: ExportDialogTrackOption[];
  /** The current clip multi-selection, for the 'clips' what-option. */
  selectedClipIds: string[];
  /** Seeds the opening name — e.g. the toolbar's mixdown-name field, so a name
   *  already typed there is not lost when this dialog opens. */
  defaultName?: string;
  /** WHAT the dialog opens on. 'clips' opens it on the selected clips, as a
   *  clip's menu does; the toolbar opens it on the mix. */
  openOn?: 'mix' | 'clips';
}

// Every word in the dialog is 12px or larger, in the bold sans the rest of the app reads in.
const LABEL = 'font-display text-[12px] font-bold uppercase tracking-wider text-zinc-400';
const FIELD =
  'w-full rounded-xs border border-white/10 bg-black/40 px-2 py-1.5 text-[12px] font-semibold text-zinc-200 outline-none focus:border-purple-500/50 disabled:opacity-40';
const RADIO_ROW = 'flex items-center gap-1.5 text-[12px] font-semibold text-zinc-300';
const NOTE = 'text-[12px] font-semibold text-zinc-400';
const BUTTON =
  'h-8 px-3 rounded-xs text-[12px] font-bold uppercase tracking-wider bg-white/10 text-zinc-200 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-white/10';

const WHAT_LABEL: Record<ExportWhat['kind'], string> = {
  mix: 'Mix — the whole timeline, one file',
  stems: 'Stems — one file per selected track',
  clips: 'Selection — the selected clip(s), one file',
};

/** WHAT for the MIDI format: one file, whichever the choice, with a MIDI track per EDIT track. */
const WHAT_LABEL_MIDI: Record<ExportWhat['kind'], string> = {
  mix: 'Every MIDI track — one file, as the mix plays them',
  stems: 'Selected tracks — one file holding those tracks',
  clips: 'Selection — the selected clip(s), one file',
};

const RANGE_LABEL: Record<ExportRangeMode, string> = {
  project: 'Whole project',
  selection: 'Current timeline selection',
  custom: 'Custom range',
};

const DESTINATION_LABEL: Record<ExportDestination, string> = {
  library: 'Library only',
  download: 'Download only (Save As)',
  both: 'Library + download',
};

export const ExportDialog: React.FC<ExportDialogProps> = ({
  onClose,
  onExport,
  projectEndSec,
  selectionSec,
  tracks,
  selectedClipIds,
  defaultName,
  openOn = 'mix',
}) => {
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    name: `${uid}-name`,
    format: `${uid}-format`,
    destination: `${uid}-destination`,
    rangeStart: `${uid}-range-start`,
    rangeEnd: `${uid}-range-end`,
    tail: `${uid}-tail`,
    tailNote: `${uid}-tail-note`,
    rangeError: `${uid}-range-error`,
    nameError: `${uid}-name-error`,
  };
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  const [state, setState] = useState<ExportDialogState>(() =>
    defaultExportState({
      projectEndSec,
      selectionSec,
      name: defaultName,
      what: openOn === 'clips' ? { kind: 'clips', clipIds: selectedClipIds } : undefined,
    }),
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('inert', '');
    appRoot?.setAttribute('aria-hidden', 'true');
    firstRef.current?.focus();
    firstRef.current?.select();
    return () => {
      appRoot?.removeAttribute('inert');
      appRoot?.removeAttribute('aria-hidden');
      previouslyFocused?.focus();
    };
  }, []);

  // Escape closes; Tab stays inside the dialog — same pattern as TrackMetaDialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const box = dialogRef.current;
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(
        box.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Each stem's file is named after its track.
  const trackNames = useMemo(() => new Map(tracks.map((t) => [t.id, t.name])), [tracks]);
  const plan = useMemo(() => buildRenderRequest(state, trackNames), [state, trackNames]);
  // MIDI writes the notes: no tail, no library, one file whatever WHAT picks.
  const midi = formatOf(state.format).kind === 'midi';
  const whatLabels = midi ? WHAT_LABEL_MIDI : WHAT_LABEL;

  const whatInvalid =
    (state.what.kind === 'stems' && state.what.trackIds.length === 0) ||
    (state.what.kind === 'clips' && state.what.clipIds.length === 0);
  const nameInvalid = state.name.trim().length === 0;
  const canExport = !plan.rangeError && !whatInvalid && !nameInvalid;
  const nameErrorMessage = nameInvalid
    ? 'Name cannot be empty.'
    : whatInvalid
      ? state.what.kind === 'stems'
        ? 'Select at least one track to export as stems.'
        : 'Select at least one clip to export.'
      : null;

  const setWhatKind = (kind: ExportWhat['kind']): void => {
    setState((s) => {
      if (kind === 'mix') return { ...s, what: { kind: 'mix' } };
      if (kind === 'stems') {
        return { ...s, what: { kind: 'stems', trackIds: s.what.kind === 'stems' ? s.what.trackIds : [] } };
      }
      return { ...s, what: { kind: 'clips', clipIds: selectedClipIds } };
    });
  };

  const toggleTrack = (trackId: string): void => {
    setState((s) => {
      const current = s.what.kind === 'stems' ? s.what.trackIds : [];
      const trackIds = current.includes(trackId)
        ? current.filter((id) => id !== trackId)
        : [...current, trackId];
      return { ...s, what: { kind: 'stems', trackIds } };
    });
  };

  const handleExport = (): void => {
    if (!canExport) return;
    onExport(plan, state);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.heading}
        aria-describedby={plan.rangeError ? ids.rangeError : undefined}
        onKeyDown={(e) => e.stopPropagation()}
        className="relative w-full max-w-md flex flex-col gap-3 p-4 bg-[#0a080f] border border-white/10 rounded-sm shadow-[0_8px_32px_rgba(0,0,0,0.75)]"
      >
        <div className="flex items-center gap-2">
          <h2 id={ids.heading} className="flex-1 min-w-0 truncate font-display text-sm font-bold uppercase tracking-wider text-zinc-100">
            Export
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 flex items-center justify-center rounded-xs text-zinc-400 hover:text-zinc-100"
          >
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleExport();
          }}
        >
          {/* WHAT ────────────────────────────────────────────────────────── */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className={LABEL}>What to export</legend>
            {(['mix', 'stems', 'clips'] as const).map((kind) => {
              const id = `${uid}-what-${kind}`;
              const disabled = kind === 'clips' && selectedClipIds.length === 0;
              return (
                <label key={kind} htmlFor={id} className={`${RADIO_ROW} ${disabled ? 'opacity-40' : ''}`}>
                  <input
                    id={id}
                    name={`${uid}-what`}
                    type="radio"
                    checked={state.what.kind === kind}
                    disabled={disabled}
                    onChange={() => setWhatKind(kind)}
                  />
                  {whatLabels[kind]}
                </label>
              );
            })}
            {state.what.kind === 'stems' && (
              <div className="flex flex-col gap-1 pl-5 max-h-32 overflow-y-auto">
                {tracks.length === 0 && <p className={NOTE}>No tracks.</p>}
                {tracks.map((track) => {
                  const id = `${uid}-track-${track.id}`;
                  const trackIds = state.what.kind === 'stems' ? state.what.trackIds : [];
                  return (
                    <label key={track.id} htmlFor={id} className={RADIO_ROW}>
                      <input
                        id={id}
                        name={id}
                        type="checkbox"
                        checked={trackIds.includes(track.id)}
                        onChange={() => toggleTrack(track.id)}
                      />
                      {track.name}
                    </label>
                  );
                })}
              </div>
            )}
            {state.what.kind === 'clips' && (
              <p className={`pl-5 ${NOTE}`}>
                {selectedClipIds.length} clip{selectedClipIds.length === 1 ? '' : 's'} selected
              </p>
            )}
          </fieldset>

          {/* RANGE ───────────────────────────────────────────────────────── */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className={LABEL}>Range</legend>
            {(['project', 'selection', 'custom'] as const).map((mode) => {
              const id = `${uid}-range-${mode}`;
              const disabled = mode === 'selection' && !selectionSec;
              return (
                <label key={mode} htmlFor={id} className={`${RADIO_ROW} ${disabled ? 'opacity-40' : ''}`}>
                  <input
                    id={id}
                    name={`${uid}-range-mode`}
                    type="radio"
                    checked={state.rangeMode === mode}
                    disabled={disabled}
                    onChange={() => setState((s) => ({ ...s, rangeMode: mode }))}
                  />
                  {RANGE_LABEL[mode]}
                </label>
              );
            })}
            {state.rangeMode === 'custom' && (
              <div className="flex items-center gap-2 pl-5">
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.rangeStart} className={LABEL}>Start (s)</label>
                  <input
                    id={ids.rangeStart}
                    name={ids.rangeStart}
                    type="number"
                    min={0}
                    step="0.01"
                    value={state.customSec.startSec}
                    onChange={(e) =>
                      setState((s) => ({ ...s, customSec: { ...s.customSec, startSec: Number(e.target.value) } }))
                    }
                    className={`${FIELD} w-20`}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.rangeEnd} className={LABEL}>End (s)</label>
                  <input
                    id={ids.rangeEnd}
                    name={ids.rangeEnd}
                    type="number"
                    min={0}
                    step="0.01"
                    value={state.customSec.endSec}
                    onChange={(e) =>
                      setState((s) => ({ ...s, customSec: { ...s.customSec, endSec: Number(e.target.value) } }))
                    }
                    className={`${FIELD} w-20`}
                  />
                </div>
              </div>
            )}
            {plan.rangeError && (
              <p id={ids.rangeError} role="alert" className="pl-5 text-[12px] font-semibold text-red-400">
                {plan.rangeError}
              </p>
            )}
            {midi && state.rangeMode !== 'project' && (
              <p className={`pl-5 ${NOTE}`}>The MIDI file starts on the bar line at or before the range, so its bars are the arrangement’s.</p>
            )}
          </fieldset>

          {/* FORMAT + DESTINATION ────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.format} className={LABEL}>Format</label>
              <select
                id={ids.format}
                name={ids.format}
                value={state.format}
                onChange={(e) => setState((s) => ({ ...s, format: e.target.value as ExportFormatId }))}
                className={FIELD}
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
            </div>
            {midi ? (
              <div className="flex flex-col gap-1">
                <p className={LABEL}>Deliver to</p>
                <p className={NOTE}>Save As: where you choose, then listed under Recent in every MIDI import</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.destination} className={LABEL}>Deliver to</label>
                <select
                  id={ids.destination}
                  name={ids.destination}
                  value={state.destination}
                  onChange={(e) => setState((s) => ({ ...s, destination: e.target.value as ExportDestination }))}
                  className={FIELD}
                >
                  {(['both', 'library', 'download'] as const).map((d) => (
                    <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <p className={NOTE}>
            {midi ? MIDI_FORMAT_LABEL : `${SAMPLE_RATE_LABEL} · ${formatOf(state.format).label}`}
          </p>

          {/* NAME + TAIL ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.name} className={LABEL}>Name</label>
              <input
                ref={firstRef}
                id={ids.name}
                name={ids.name}
                type="text"
                required
                aria-invalid={nameErrorMessage !== null}
                aria-describedby={nameErrorMessage !== null ? ids.nameError : undefined}
                value={state.name}
                onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                className={FIELD}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.tail} className={LABEL}>Tail (s)</label>
              <input
                id={ids.tail}
                name={ids.tail}
                type="number"
                min={0}
                max={MAX_TAIL_SEC}
                step="0.5"
                value={state.tailSec}
                // A MIDI file has no audio to ring out; the value stays for when an audio format is chosen again.
                disabled={midi}
                aria-describedby={midi ? ids.tailNote : undefined}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  const clamped = Number.isFinite(raw) ? Math.min(MAX_TAIL_SEC, Math.max(0, raw)) : 0;
                  setState((s) => ({ ...s, tailSec: clamped }));
                }}
                className={`${FIELD} w-16`}
              />
            </div>
          </div>
          {midi && (
            <p id={ids.tailNote} className={NOTE}>A MIDI file has no tail: its notes end where they end.</p>
          )}
          {nameErrorMessage !== null && (
            <p id={ids.nameError} role="alert" className="text-[12px] font-semibold text-red-400">
              {nameErrorMessage}
            </p>
          )}

          {/* PREVIEW ─────────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1">
            <p className={LABEL}>Will write</p>
            <ul className="flex flex-col gap-0.5 text-[12px] font-semibold text-zinc-400 max-h-24 overflow-y-auto">
              {plan.items.map((item, i) => (
                <li key={`${item.label}-${i}`}>{item.label} — {DESTINATION_LABEL[item.destination]}</li>
              ))}
              {plan.midiItems.map((item, i) => (
                <li key={`midi-${item.label}-${i}`}>{item.label} — Save As</li>
              ))}
            </ul>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={BUTTON}>Cancel</button>
            <button type="submit" disabled={!canExport} className={`${BUTTON} text-purple-300`}>Export</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
};
