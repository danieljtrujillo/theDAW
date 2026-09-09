/**
 * Renders the feature notes: a small card pinned beside a hard-to-find control,
 * with a pointer aimed at it and a close button.
 *
 * Positioning is measured, not guessed. The targets are things like the
 * library's slim edge tab, which moves with the viewport, the dock height and
 * the right rail's width, so every note re-measures on resize, on scroll, and
 * whenever the DOM around it changes. A note whose target is not on screen
 * simply does not render.
 *
 * The card never covers its own target and never eats a click meant for it:
 * the layer is `pointer-events-none` and only the card and its close button
 * take pointer events back.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { FEATURE_NOTES } from './featureNoteList';
import { useFeatureNoteStore, type FeatureNoteDef, type NotePlacement } from './featureNoteStore';

/** Gap between the target's edge and the card, leaving room for the pointer. */
const OFFSET = 14;
/** Keep the card this far inside the viewport when a target sits near an edge. */
const MARGIN = 8;
const CARD_W = 208;

interface Box { top: number; left: number; width: number; height: number }

const readBox = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

/** Card position for a target box, clamped into the viewport. */
export function placeNote(
  target: Box,
  placement: NotePlacement,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  let top: number;
  let left: number;
  switch (placement) {
    case 'left':
      left = target.left - card.width - OFFSET;
      top = target.top + target.height / 2 - card.height / 2;
      break;
    case 'right':
      left = target.left + target.width + OFFSET;
      top = target.top + target.height / 2 - card.height / 2;
      break;
    case 'top':
      left = target.left + target.width / 2 - card.width / 2;
      top = target.top - card.height - OFFSET;
      break;
    default:
      left = target.left + target.width / 2 - card.width / 2;
      top = target.top + target.height + OFFSET;
      break;
  }
  return {
    left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - card.width - MARGIN)),
    top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - card.height - MARGIN)),
  };
}

// The little triangle, on the card edge nearest the target. A 8px square
// rotated 45 degrees, pulled out by exactly half its width so it reads as a
// point growing out of the edge rather than a diamond stuck to it.
const POINTER: Record<NotePlacement, string> = {
  left: '-right-1 top-1/2 -translate-y-1/2',
  right: '-left-1 top-1/2 -translate-y-1/2',
  top: '-bottom-1 left-1/2 -translate-x-1/2',
  bottom: '-top-1 left-1/2 -translate-x-1/2',
};

const Note: React.FC<{ def: FeatureNoteDef; onDismiss: (id: string) => void }> = ({ def, onDismiss }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const measure = useCallback(() => {
    const el = document.querySelector(def.target);
    const card = cardRef.current;
    if (!el || !card) {
      setPos(null);
      return;
    }
    const box = readBox(el);
    // A target with no box is hidden (display:none, a closed panel): say nothing.
    if (box.width <= 0 || box.height <= 0) {
      setPos(null);
      return;
    }
    setPos(
      placeNote(
        box,
        def.placement,
        { width: card.offsetWidth || CARD_W, height: card.offsetHeight || 64 },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [def.target, def.placement]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    schedule();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // The rail and the dock resize without a window event, so watch the target
    // and the layout around it rather than polling.
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    const el = document.querySelector(def.target);
    if (el) ro.observe(el);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [measure, def.target]);

  // A target the screen reader lands on should say what the note says, so the
  // hint is not sighted-only.
  useEffect(() => {
    const el = document.querySelector(def.target);
    if (!el) return;
    const prev = el.getAttribute('aria-describedby');
    el.setAttribute('aria-describedby', [prev, titleId, bodyId].filter(Boolean).join(' '));
    return () => {
      if (prev) el.setAttribute('aria-describedby', prev);
      else el.removeAttribute('aria-describedby');
    };
  }, [def.target, titleId, bodyId]);

  return (
    <div
      ref={cardRef}
      role="note"
      // Measured off-screen on the first paint, then pinned.
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      className={`fixed z-1000 w-52 pointer-events-auto rounded-lg border border-amber-300/50 bg-amber-100 text-zinc-900 shadow-[0_6px_24px_rgba(0,0,0,0.55)] ${pos ? '' : 'invisible'}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDismiss(def.id);
      }}
    >
      <div className={`absolute w-2 h-2 rotate-45 border border-amber-300/50 bg-amber-100 ${POINTER[def.placement]}`} aria-hidden="true" />
      <div className="relative flex items-start gap-1.5 px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-900">
            {def.label}
          </p>
          <p id={bodyId} className="mt-0.5 text-[11px] leading-snug text-zinc-800">{def.body}</p>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(def.id)}
          title={`Hide the ${def.label} note`}
          aria-label={`Hide the ${def.label} feature note`}
          className="shrink-0 -mr-0.5 -mt-0.5 rounded p-0.5 text-amber-900/70 hover:bg-amber-900/10 hover:text-amber-900 focus-visible:outline-2 focus-visible:outline-amber-900"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export const FeatureNotes: React.FC = () => {
  const enabled = useFeatureNoteStore((s) => s.enabled);
  const dismissed = useFeatureNoteStore((s) => s.dismissed);
  const dismiss = useFeatureNoteStore((s) => s.dismiss);

  const visible = useMemo(
    () => (enabled ? FEATURE_NOTES.filter((d) => !dismissed.includes(d.id)) : []),
    [enabled, dismissed],
  );

  // Using the feature retires its note, so the app stops pointing at something
  // the user has already found. Polled rather than subscribed, because the
  // notes read several unrelated stores and a slow tick is plenty for a hint —
  // but only while a note is actually up, so the common case (all dismissed)
  // leaves no timer running for the life of the session.
  const [, tick] = useState(0);
  const watching = visible.some((d) => d.learned);
  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => tick((n) => n + 1), 800);
    return () => window.clearInterval(id);
  }, [watching]);

  useEffect(() => {
    for (const def of visible) {
      if (def.learned?.()) dismiss(def.id);
    }
  });

  if (!visible.length) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-1000" aria-live="off">
      {visible.map((def) => (
        <Note key={def.id} def={def} onDismiss={dismiss} />
      ))}
    </div>
  );
};

export default FeatureNotes;
