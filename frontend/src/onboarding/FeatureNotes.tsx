/**
 * Renders the feature notes: a small card pinned beside a hard-to-find control,
 * with a leader line aimed at it and a close button.
 *
 * Positioning is measured, not guessed. The targets are things like the bottom
 * strip's LOG and PANELS labels, which move with the viewport, the dock height
 * and the right rail's width, so every note re-measures on resize, on scroll,
 * and whenever the DOM around it changes. A note whose target is not on screen
 * simply does not render.
 *
 * Target coordinates come from getBoundingClientRect() and the layer is
 * portaled to <body> and fixed-positioned, so it shares the target's viewport
 * coordinate space — the shell's CSS zoom (Shell.tsx's `.dense-layout`) does not
 * apply to it. This is not a tidiness point. Rendered inside that zoom, a
 * fixed card's `top`/`left` were multiplied by a factor that is essentially
 * never 1 (lib/layoutScale.ts clamps it to 0.6–1.1), so every note landed a
 * long way from the thing it named. The card's CONTENT is zoomed back to the
 * shell's scale, so it still reads at the same size as the strip it sits on.
 *
 * The card never covers its own target and never eats a click meant for it:
 * the layer is `pointer-events-none` and only the card and its close button
 * take pointer events back.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLayoutZoom } from '../lib/layoutScale';
import { FEATURE_NOTES } from './featureNoteList';
import { useFeatureNoteStore, type FeatureNoteDef } from './featureNoteStore';
import { SpotlightPointer } from './SpotlightPointer';
import { CARD_W, placeNote, type Box } from './spotlightGeometry';

/** Fallback card height before the first measurement. */
const CARD_H = 64;

interface NoteGeometry {
  card: Box;
  target: Box;
}

const readBox = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

const sameBox = (a: Box, b: Box): boolean =>
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

const sameGeometry = (a: NoteGeometry | null, b: NoteGeometry): boolean =>
  !!a && sameBox(a.card, b.card) && sameBox(a.target, b.target);

const Note: React.FC<{ def: FeatureNoteDef; zoom: number; onDismiss: (id: string) => void }> = ({
  def,
  zoom,
  onDismiss,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<NoteGeometry | null>(null);
  const titleId = useId();
  const bodyId = useId();

  // Both boxes are kept, not just the card's position: the leader is drawn from
  // the FINAL, clamped card rect to the target rect, and there is no way to aim
  // it from either one alone.
  const measure = useCallback(() => {
    const el = document.querySelector(def.target);
    const card = cardRef.current;
    if (!el || !card) {
      setGeo(null);
      return;
    }
    const target = readBox(el);
    // A target with no box is hidden (display:none, a closed panel): say nothing.
    if (target.width <= 0 || target.height <= 0) {
      setGeo(null);
      return;
    }
    const measured = card.getBoundingClientRect();
    const size = { width: measured.width || CARD_W, height: measured.height || CARD_H };
    const next: NoteGeometry = {
      card: { ...placeNote(target, def.placement, size, { width: window.innerWidth, height: window.innerHeight }), ...size },
      target,
    };
    setGeo((prev) => (sameGeometry(prev, next) ? prev : next));
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
    <>
      {/* Before the card, so the card paints over the seam where the stem meets its border. */}
      {geo && <SpotlightPointer card={geo.card} target={geo.target} />}
      <div
        ref={cardRef}
        role="note"
        // Measured off-screen on the first paint, then pinned.
        style={geo ? { top: geo.card.top, left: geo.card.left } : { top: -9999, left: -9999 }}
        className={`fixed pointer-events-auto ${geo ? '' : 'invisible'}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDismiss(def.id);
        }}
      >
        {/* The shell's scale, applied to the content only: the wrapper above
            stays in unzoomed viewport px so the placement maths holds, while
            the card still reads at the size of the strip it is pinned to. */}
        <div
          style={{ zoom }}
          className="w-52 rounded-lg border border-purple-500/40 bg-[#0c0a14]/97 backdrop-blur-xl text-zinc-200 shadow-[0_0_24px_rgba(168,85,247,0.28),0_8px_28px_rgba(0,0,0,0.6)]"
        >
          <div className="flex items-start gap-1.5 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <p id={titleId} className="text-[10px] font-black uppercase tracking-[0.18em] text-purple-200">
                {def.label}
              </p>
              <p id={bodyId} className="mt-0.5 text-[11px] leading-snug text-zinc-400">{def.body}</p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(def.id)}
              title={`Hide the ${def.label} note`}
              aria-label={`Hide the ${def.label} feature note`}
              className="shrink-0 p-1 rounded border border-transparent text-zinc-500 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export const FeatureNotes: React.FC = () => {
  const enabled = useFeatureNoteStore((s) => s.enabled);
  const dismissed = useFeatureNoteStore((s) => s.dismissed);
  const dismiss = useFeatureNoteStore((s) => s.dismiss);
  const zoom = useLayoutZoom();

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

  // A note retires on the TRANSITION into `learned`, not on finding it already
  // true. Finding a panel open is not the same as watching someone open it, and
  // the two come apart in a case that used to burn a note before its feature
  // was ever found: the tour opens panels in order to point at them, this layer
  // is unmounted while it does, and the panel is handed back a beat after the
  // layer comes back. Seeing "open" on the first look proves nothing.
  const wasLearned = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const def of visible) {
      if (!def.learned) continue;
      const now = def.learned();
      const before = wasLearned.current[def.id];
      wasLearned.current[def.id] = now;
      if (now && before === false) dismiss(def.id);
    }
  });

  if (!visible.length) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-1000" aria-live="off">
      {visible.map((def) => (
        <Note key={def.id} def={def} zoom={zoom} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
};

export default FeatureNotes;
