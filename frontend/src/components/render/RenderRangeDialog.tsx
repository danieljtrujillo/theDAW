/**
 * "Render range…" popover (F24-6): a small dialog over the timeline that
 * turns the current time selection into a render decision. All the deciding
 * (clamping, whether the selection is renderable, the job title) lives in
 * F24-5's renderRangeDialogModel.ts; this component only renders that
 * model's state and hands the caller its `onConfirm` result. It does not
 * queue a render job itself — a later ticket wires the result into
 * renderJobs/renderCore.
 */
import React, { useEffect, useRef, useState } from 'react';
import { MAX_TAIL_SEC, type RenderRange } from '../../lib/render/renderRange';
import {
  clampPrerollSec,
  clampTailSec,
  DEFAULT_RANGE_FORM,
  planRangeRenderJob,
  tailHint,
  type RangeRenderForm,
  type RangeRenderPlanResult,
} from './renderRangeDialogModel';
import { FLYOUT_CARD } from '../audio/midiDockKit';

/** Preroll's own ceiling (mirrors renderRangeDialogModel.ts's private
 *  MAX_PREROLL_SEC, not exported): wider than the render engine's tail cap
 *  because preroll is thrown away, never kept, so there is no render-length
 *  cost to allowing more of it. */
const MAX_PREROLL_SEC = 30;

const LABEL = 'font-display text-xs font-bold uppercase tracking-wider et-ink-2';
const FIELD = 'w-full rounded-xs border border-white/10 bg-black/40 px-2 py-1.5 text-sm font-semibold et-ink';
const BUTTON =
  'h-8 px-3 rounded-xs text-xs font-bold uppercase tracking-wider bg-white/10 et-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.1)] disabled:*:opacity-40';

interface RenderRangeDialogProps {
  open: boolean;
  selection: { startSec: number; endSec: number } | null;
  /** Viewport coords to open beside (a right-click or a toolbar button's own
   *  rect). A missing anchor centers the popover instead. */
  anchor?: { x: number; y: number };
  onCancel: () => void;
  onConfirm: (result: { title: string; range: RenderRange }) => void;
}

export const RenderRangeDialog: React.FC<RenderRangeDialogProps> = ({
  open,
  selection,
  anchor,
  onCancel,
  onConfirm,
}) => {
  const [form, setForm] = useState<RangeRenderForm>(DEFAULT_RANGE_FORM);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Fresh form every time the popover opens, never a previous session's typed name.
  useEffect(() => {
    if (open) setForm(DEFAULT_RANGE_FORM);
  }, [open]);

  useEffect(() => {
    if (open) nameRef.current?.focus();
  }, [open]);

  // Escape closes; Tab stays inside the popover. Capture phase so this runs
  // before the timeline's own window-level shortcuts (Delete removes clips).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const box = dialogRef.current;
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(box.querySelectorAll<HTMLElement>('input, button:not([disabled])'));
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
  }, [open, onCancel]);

  if (!open) return null;

  const plan = planRangeRenderJob(selection, form);
  // Non-strict tsconfig (no strictNullChecks) does not narrow a boolean
  // discriminant through a `!plan.ok` falsy check (see
  // renderRangeDialogModel.test.ts), so cast the same way that test does.
  const refusalReason = plan.ok ? null : (plan as Extract<RangeRenderPlanResult, { ok: false }>).reason;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (plan.ok) onConfirm({ title: plan.title, range: plan.range });
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="render-range-title"
      // Keys stop here: the timeline's own hotkeys (Delete removes clips, etc.)
      // would otherwise act behind the popover while one of its fields has focus.
      onKeyDown={(e) => e.stopPropagation()}
      className={`fixed z-10000 w-80 flex flex-col gap-3 p-3 ${FLYOUT_CARD}`}
      style={
        anchor
          ? { left: anchor.x, top: anchor.y }
          : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
      }
    >
      <h2 id="render-range-title" className="font-display text-sm font-bold uppercase tracking-wider et-ink">
        Render range
      </h2>

      <div className="flex items-center justify-between gap-2 text-[12px] font-semibold et-ink-3">
        <span>Selection</span>
        <span className="tabular-nums">
          {selection ? `${selection.startSec.toFixed(3)}s to ${selection.endSec.toFixed(3)}s` : 'No selection'}
        </span>
      </div>

      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="flex flex-col gap-1">
          <label htmlFor="render-range-name" className={LABEL}>
            Name
          </label>
          <input
            ref={nameRef}
            id="render-range-name"
            name="render-range-name"
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className={FIELD}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="render-range-tail" className={LABEL}>
            Include effect tail (seconds)
          </label>
          <input
            id="render-range-tail"
            name="render-range-tail"
            type="number"
            min={0}
            max={MAX_TAIL_SEC}
            step={0.1}
            value={form.tailSec}
            aria-describedby="render-range-tail-hint"
            onChange={(e) => setForm((f) => ({ ...f, tailSec: clampTailSec(e.target.valueAsNumber) }))}
            className={FIELD}
          />
          <p id="render-range-tail-hint" className="text-[12px] font-semibold et-ink-3 leading-snug">
            {tailHint(form.tailSec)}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="render-range-preroll" className={LABEL}>
            Preroll (seconds)
          </label>
          <input
            id="render-range-preroll"
            name="render-range-preroll"
            type="number"
            min={0}
            max={MAX_PREROLL_SEC}
            step={0.1}
            value={form.prerollSec}
            onChange={(e) => setForm((f) => ({ ...f, prerollSec: clampPrerollSec(e.target.valueAsNumber) }))}
            className={FIELD}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {refusalReason && (
            <p id="render-range-refusal" className="flex-1 min-w-0 text-[12px] font-semibold et-ink-3">
              {refusalReason}
            </p>
          )}
          <button type="button" onClick={onCancel} className={BUTTON}>
            <span>Cancel</span>
          </button>
          <button
            type="submit"
            disabled={!plan.ok}
            aria-describedby={refusalReason ? 'render-range-refusal' : undefined}
            className={`${BUTTON} text-[rgb(var(--et-accent))]`}
          >
            <span>Render range</span>
          </button>
        </div>
      </form>
    </div>
  );
};
